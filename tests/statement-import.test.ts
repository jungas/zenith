/**
 * Turning statement rows into transactions.
 *
 * The assertion that matters most in this file is the reconciliation identity
 * from `core/budget.ts`:
 *
 *     readyToAssign + Σ available === Σ cash in asset accounts
 *
 * Every shape an imported row can take is checked against it. A card refund
 * recorded as income, or a card payment recorded without the account it came
 * out of, would each break that identity — and would do it quietly, showing up
 * weeks later as a number that no longer adds up.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as actions from '../src/core/actions.ts';
import { emptyState, paymentCategoryFor } from '../src/core/model.ts';
import type { AppState } from '../src/core/model.ts';
import { accountBalance, buildLedger, reconcile } from '../src/core/budget.ts';
import { readPdfText } from '../src/core/pdf/read.ts';
import { parseStatement } from '../src/core/statement.ts';
import type { StatementRow } from '../src/core/statement.ts';
import {
  applyImport, buildDrafts, guessCategoryId, importTotals, normalisePayee,
  reconcileWithStatement, suggestAccountId,
} from '../src/core/statement-import.ts';
import { account, category, must, paymentEnvelope } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MONTH = '2026-06';

/** The BDO fixture, parsed as of a fixed day. Its own figures add up. */
function bdoStatement() {
  const bytes = new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures/bdo-card-aes256.pdf')));
  return { parsed: parseStatement(readPdfText(bytes, '7788').lines, { today: new Date(2026, 6, 1) }) };
}

/** Chequing with cash in it, one card, one spending category. */
function baseState(): AppState {
  let state = emptyState(new Date(2026, 5, 1));
  state = actions.addAccount(state, {
    name: 'Everyday Checking', type: 'checking', openingBalance: 10_000_00, openedOn: '2026-06-01',
  });
  state = actions.addAccount(state, {
    name: 'BDO Visa', type: 'credit', provider: 'BDO', openingBalance: 0,
    openedOn: '2026-06-01', creditLimit: 200_000_00,
  });
  state = actions.addCategory(state, { name: 'Groceries', group: 'Everyday' });
  return state;
}

function row(patch: Partial<StatementRow>): StatementRow {
  return {
    id: 'row-1', date: '2026-06-05', postedDate: null, description: 'Test merchant',
    amount: 1_000_00, direction: 'debit', reason: 'default', page: 1, raw: '', ...patch,
  };
}

const assertBalanced = (state: AppState, what: string): void => {
  const check = reconcile(state, MONTH);
  assert.ok(
    check.balanced,
    `${what}: out by ${check.difference} — readyToAssign ${check.readyToAssign} + available ${check.available} != cash ${check.cash}`,
  );
};

/* ── The four shapes ──────────────────────────────────────────────────── */

test('a charge on a card is spending that reserves its own payment', () => {
  const state = baseState();
  const card = account(state, 'BDO Visa');
  const groceries = category(state, 'Groceries');

  const drafts = buildDrafts(state, [row({ description: 'SM Supermarket', amount: 2_845_60 })], {
    accountId: card.id,
  });
  assert.equal(drafts[0]?.role, 'charge');
  assert.equal(drafts[0]?.amount, -2_845_60, 'a charge leaves the account');

  const next = applyImport(state, [{ ...must(drafts[0], 'draft'), categoryId: groceries.id }], card.id);

  assert.equal(accountBalance(next, card.id), -2_845_60, 'the card now owes it');
  const envelope = paymentEnvelope(next, card.id);
  // The charge drew down Groceries and put the same cash aside for the bill.
  const month = must(buildLedger(next, MONTH).get(MONTH), 'the month summary');
  assert.equal(must(month.rows.get(envelope.id), 'payment envelope row').reserved, 2_845_60);
  assertBalanced(next, 'card charge');
});

test('a refund on a card returns the money to its envelope, not to income', () => {
  let state = baseState();
  const card = account(state, 'BDO Visa');
  const groceries = category(state, 'Groceries');

  // Charge first, then refund the same amount: the card and the budget should
  // both end up exactly where they started.
  const charge = buildDrafts(state, [row({ description: 'SM Supermarket', amount: 2_845_60 })], {
    accountId: card.id,
  });
  state = applyImport(state, [{ ...must(charge[0], 'charge'), categoryId: groceries.id }], card.id);

  const refund = buildDrafts(
    state,
    [row({ id: 'row-2', description: 'REVERSAL - SM Supermarket', amount: 2_845_60, direction: 'credit' })],
    { accountId: card.id },
  );
  assert.equal(refund[0]?.role, 'refund');
  assert.equal(refund[0]?.amount, 2_845_60);

  const next = applyImport(state, [{ ...must(refund[0], 'refund'), categoryId: groceries.id }], card.id);

  assert.equal(accountBalance(next, card.id), 0, 'the card owes nothing again');
  const refundTx = must(
    next.transactions.find((t) => t.payee.includes('REVERSAL')),
    'the refund transaction',
  );
  assert.equal(refundTx.kind, 'expense', 'a refund is negative spending, not income');
  assert.equal(reconcile(next, MONTH).readyToAssign, reconcile(baseState(), MONTH).readyToAssign);
  assertBalanced(next, 'card refund');
});

test('a payment to a card is recorded as a transfer from a real account', () => {
  const state = baseState();
  const card = account(state, 'BDO Visa');
  const checking = account(state, 'Everyday Checking');

  const drafts = buildDrafts(
    state,
    [row({ description: 'PAYMENT - THANK YOU', amount: 3_000_00, direction: 'credit' })],
    { accountId: card.id, paymentSourceId: checking.id },
  );
  assert.equal(drafts[0]?.role, 'payment');

  const next = applyImport(state, drafts, card.id);

  const legs = next.transactions.filter((t) => t.transferId);
  assert.equal(legs.length, 2, 'a transfer is always a linked pair');
  assert.equal(accountBalance(next, checking.id), 10_000_00 - 3_000_00);
  assert.equal(accountBalance(next, card.id), 3_000_00);
  // The outflow leg is categorised to the card's payment envelope — that single
  // line is the whole connection between the budget and the debt.
  const outflow = must(legs.find((t) => t.amount < 0), 'the outflow leg');
  assert.equal(outflow.categoryId, paymentCategoryFor(next, card.id)?.id);
  assertBalanced(next, 'card payment');
});

test('a payment with no source account is skipped rather than guessed at', () => {
  const state = baseState();
  const card = account(state, 'BDO Visa');

  const drafts = buildDrafts(
    state,
    [row({ description: 'PAYMENT - THANK YOU', amount: 3_000_00, direction: 'credit' })],
    { accountId: card.id, paymentSourceId: null },
  );
  assert.equal(importTotals(drafts).unassignedPayments, 1);

  const next = applyImport(state, drafts, card.id);
  assert.equal(next.transactions.length, state.transactions.length, 'nothing was written');
  assertBalanced(next, 'unassigned card payment');
});

test('spending and income on a bank account take their ordinary shapes', () => {
  const state = baseState();
  const checking = account(state, 'Everyday Checking');
  const groceries = category(state, 'Groceries');

  const drafts = buildDrafts(
    state,
    [
      row({ id: 'a', description: 'Puregold', amount: 1_200_00, direction: 'debit' }),
      row({ id: 'b', description: 'SALARY CREDIT', amount: 50_000_00, direction: 'credit' }),
    ],
    { accountId: checking.id },
  );
  assert.deepEqual(drafts.map((d) => d.role), ['expense', 'income']);

  const next = applyImport(
    state,
    [{ ...must(drafts[0], 'expense'), categoryId: groceries.id }, must(drafts[1], 'income')],
    checking.id,
  );

  assert.equal(accountBalance(next, checking.id), 10_000_00 - 1_200_00 + 50_000_00);
  // Income is budgetable cash, so Ready to assign grows by the whole salary.
  // The spending does not reduce it: it draws down the Groceries envelope, and
  // overspending an envelope is absorbed by *next* month's Ready to assign —
  // which is what actually happened to the money.
  assert.equal(
    reconcile(next, MONTH).readyToAssign - reconcile(state, MONTH).readyToAssign,
    50_000_00,
  );
  assertBalanced(next, 'bank spending and income');
});

/* ── Duplicates ───────────────────────────────────────────────────────── */

test('a row already in the ledger arrives unticked', () => {
  let state = baseState();
  const card = account(state, 'BDO Visa');
  state = actions.addTransaction(state, {
    date: '2026-06-05', accountId: card.id, payee: 'SM Supermarket', amount: -2_845_60, kind: 'expense',
  });

  const drafts = buildDrafts(state, [row({ description: 'SM Supermarket', amount: 2_845_60 })], {
    accountId: card.id,
  });
  assert.ok(drafts[0]?.duplicateOf, 'expected a duplicate match');
  assert.equal(drafts[0]?.include, false);
  assert.equal(importTotals(drafts).selected, 0);
});

test('a duplicate is matched across a few days, since posting dates drift', () => {
  let state = baseState();
  const card = account(state, 'BDO Visa');
  state = actions.addTransaction(state, {
    date: '2026-06-02', accountId: card.id, payee: 'Shell', amount: -1_000_00, kind: 'expense',
  });

  const near = buildDrafts(state, [row({ date: '2026-06-05', amount: 1_000_00 })], { accountId: card.id });
  assert.ok(near[0]?.duplicateOf, 'three days apart is the same transaction');

  const far = buildDrafts(state, [row({ date: '2026-06-20', amount: 1_000_00 })], { accountId: card.id });
  assert.equal(far[0]?.duplicateOf, null, 'eighteen days apart is a different one');
});

test('two identical rows are not both absorbed by one existing transaction', () => {
  let state = baseState();
  const card = account(state, 'BDO Visa');
  state = actions.addTransaction(state, {
    date: '2026-06-05', accountId: card.id, payee: 'Coffee', amount: -180_00, kind: 'expense',
  });

  const drafts = buildDrafts(
    state,
    [
      row({ id: 'a', date: '2026-06-05', description: 'Coffee', amount: 180_00 }),
      row({ id: 'b', date: '2026-06-05', description: 'Coffee', amount: 180_00 }),
    ],
    { accountId: card.id },
  );
  // Two coffees on one day at one price is a real thing; only one of them can
  // be the transaction that is already recorded.
  assert.ok(drafts[0]?.duplicateOf);
  assert.equal(drafts[1]?.duplicateOf, null);
  assert.equal(importTotals(drafts).selected, 1);
});

test('a bill paid ahead of its due date is recognised when the statement later posts it', () => {
  let state = baseState();
  const checking = account(state, 'Everyday Checking');
  const groceries = category(state, 'Groceries');
  state = actions.addBill(state, {
    name: 'Electricity', payee: 'Meralco', amount: 1_500_00, cadence: 'monthly',
    startDate: '2026-06-15', categoryId: groceries.id, accountId: checking.id,
  });
  const bill = must(state.bills.find((b) => b.name === 'Electricity'), 'the bill');

  // Paid a week before the due date — a common autopay pattern — and recorded
  // that same day rather than when the bank will actually post it.
  state = actions.payBill(state, { billId: bill.id, dueDate: '2026-06-15', date: '2026-06-08' });

  // The statement then posts it on the due date itself: eight days from when it
  // was recorded, well past the ordinary four-day window.
  const drafts = buildDrafts(
    state,
    [row({ date: '2026-06-15', description: 'Meralco', amount: 1_500_00 })],
    { accountId: checking.id },
  );
  assert.ok(drafts[0]?.duplicateOf, 'the due date bridges the gap the payment date left');
  assert.equal(drafts[0]?.duplicateBy, 'near');
  assert.equal(drafts[0]?.include, false);
});

test('an ordinary transaction still needs the tight window a bill payment does not', () => {
  let state = baseState();
  const checking = account(state, 'Everyday Checking');
  // Same shape as the bill case, minus the billId: eight days apart is still
  // too far for a transaction with no due date to anchor the match on.
  state = actions.addTransaction(state, {
    date: '2026-06-08', accountId: checking.id, payee: 'Meralco', amount: -1_500_00, kind: 'expense',
  });

  const drafts = buildDrafts(
    state,
    [row({ date: '2026-06-15', description: 'Meralco', amount: 1_500_00 })],
    { accountId: checking.id },
  );
  assert.equal(drafts[0]?.duplicateOf, null, 'no billId, no widened window');
});

/* ── The posting date, and importing a statement twice ────────────────── */

test('importing the same statement twice adds nothing the second time', () => {
  const state = baseState();
  const card = account(state, 'BDO Visa');
  const checking = account(state, 'Everyday Checking');
  const groceries = category(state, 'Groceries');
  const { parsed } = bdoStatement();

  const options = { accountId: card.id, memo: 'BDO statement 2026-06-18', paymentSourceId: checking.id };
  const first = buildDrafts(state, parsed.rows, options).map((draft) =>
    draft.role === 'charge' && !draft.categoryId ? { ...draft, categoryId: groceries.id } : draft,
  );
  const imported = applyImport(state, first, card.id);

  // The second pass reads the ledger the first one wrote. Every row is matched by
  // the date the bank posted it — the one thing about a row that a statement will
  // never say differently — so nothing is offered again.
  const second = buildDrafts(imported, parsed.rows, options);
  assert.equal(second.length, parsed.rows.length);
  assert.ok(second.every((draft) => draft.duplicateOf), 'every row was recognised');
  assert.ok(second.every((draft) => draft.duplicateBy === 'posted'), 'matched on the posting date');
  assert.ok(second.every((draft) => !draft.include), 'and none of them arrive ticked');
  assert.equal(importTotals(second).selected, 0);
  assert.equal(importTotals(second).duplicates, parsed.rows.length);

  // Belt and braces: even importing the unticked result writes nothing.
  const twice = applyImport(imported, second, card.id);
  assert.equal(twice.transactions.length, imported.transactions.length, 'nothing was written');
  assert.equal(accountBalance(twice, card.id), accountBalance(imported, card.id));
  assert.equal(accountBalance(twice, checking.id), accountBalance(imported, checking.id));
  assertBalanced(twice, 'statement imported twice');
});

test('every transaction an import writes carries the date the bank posted it', () => {
  const state = baseState();
  const card = account(state, 'BDO Visa');
  const checking = account(state, 'Everyday Checking');
  const { parsed } = bdoStatement();

  const drafts = buildDrafts(state, parsed.rows, {
    accountId: card.id, paymentSourceId: checking.id,
  });
  const next = applyImport(state, drafts, card.id);

  const written = next.transactions.filter((tx) => !tx.system);
  assert.equal(written.length, 9, 'eight rows, with the payment recorded as two legs');
  assert.ok(written.every((tx) => Boolean(tx.postedDate)), 'charges, the refund and both transfer legs');

  // The payment moved money once, so its two legs agree on when it was posted.
  const legs = written.filter((tx) => tx.transferId);
  assert.equal(legs.length, 2);
  assert.equal(legs[0]?.postedDate, '2026-05-31', "the statement's posting date, not its transaction date");
  assert.equal(legs[1]?.postedDate, legs[0]?.postedDate);
});

test('a statement that prints one date gives every row that date as its posting date', () => {
  const state = baseState();
  const checking = account(state, 'Everyday Checking');

  // Most bank statements print a single date column, and that column *is* the
  // posting date. Keeping it is what lets a re-import recognise the row.
  const drafts = buildDrafts(state, [row({ date: '2026-06-05', postedDate: null })], {
    accountId: checking.id,
  });
  assert.equal(drafts[0]?.postedDate, '2026-06-05');

  const next = applyImport(state, drafts, checking.id);
  const tx = must(next.transactions.find((t) => t.payee === 'Test merchant'), 'the imported row');
  assert.equal(tx.postedDate, '2026-06-05');
  assert.equal(buildDrafts(next, [row({ date: '2026-06-05', postedDate: null })], {
    accountId: checking.id,
  })[0]?.duplicateBy, 'posted');
});

test('the posting date recognises a row whose own date has since been changed', () => {
  let state = baseState();
  const card = account(state, 'BDO Visa');
  const statementRow = row({ date: '2026-06-05', postedDate: '2026-06-07', amount: 1_000_00 });

  state = applyImport(state, buildDrafts(state, [statementRow], { accountId: card.id }), card.id);
  const tx = must(state.transactions.find((t) => t.payee === 'Test merchant'), 'the imported row');
  assert.equal(tx.postedDate, '2026-06-07', "the bank's own date is what was kept");

  // Someone corrects the date to when they actually bought the thing — five
  // weeks away, far outside the window the old check had to rely on.
  state = actions.updateTransaction(state, tx.id, { date: '2026-07-14' });

  const again = buildDrafts(state, [statementRow], { accountId: card.id });
  assert.equal(again[0]?.duplicateOf, tx.id);
  assert.equal(again[0]?.duplicateBy, 'posted');
  assert.equal(again[0]?.include, false);
});

test('one transaction cannot absorb two rows posted on the same day', () => {
  let state = baseState();
  const card = account(state, 'BDO Visa');
  const coffee = row({ id: 'a', date: '2026-06-05', postedDate: '2026-06-06', description: 'Coffee', amount: 180_00 });

  state = applyImport(state, buildDrafts(state, [coffee], { accountId: card.id }), card.id);

  // The next statement carries two of them: one is the row already imported, the
  // other is a second cup. An exact posting date is certainty about *a* row, not
  // a licence to swallow every row that shares it.
  const drafts = buildDrafts(state, [coffee, { ...coffee, id: 'b' }], { accountId: card.id });
  assert.equal(drafts[0]?.duplicateBy, 'posted');
  assert.equal(drafts[1]?.duplicateOf, null);
  assert.equal(importTotals(drafts).selected, 1);
});

/* ── Learning from the ledger ─────────────────────────────────────────── */

test('a payee is matched despite the noise statements add to it', () => {
  assert.equal(normalisePayee('SM SUPERMARKET MAKATI 214'), 'sm supermarket makati');
  assert.equal(normalisePayee('GRAB *TRIP  #8891'), 'grab trip');
});

test('a category is guessed from what that payee was filed under before', () => {
  let state = baseState();
  const card = account(state, 'BDO Visa');
  const groceries = category(state, 'Groceries');
  state = actions.addTransaction(state, {
    date: '2026-05-11', accountId: card.id, categoryId: groceries.id,
    payee: 'SM Supermarket Makati', amount: -1_000_00, kind: 'expense',
  });

  assert.equal(guessCategoryId(state, 'SM SUPERMARKET MAKATI 214'), groceries.id);
  assert.equal(guessCategoryId(state, 'Some Shop Never Seen'), null);

  const drafts = buildDrafts(state, [row({ description: 'SM SUPERMARKET MAKATI 214', amount: 500_00 })], {
    accountId: card.id,
  });
  assert.equal(drafts[0]?.categoryId, groceries.id);
});

test('the statement is offered to the account it belongs to', () => {
  const state = baseState();
  const card = account(state, 'BDO Visa');
  assert.equal(
    suggestAccountId(state, { accountHint: null, issuer: 'BDO', kind: 'card' }),
    card.id,
    'matched on the issuing bank',
  );
  assert.equal(
    suggestAccountId(state, { accountHint: null, issuer: null, kind: 'bank' }),
    account(state, 'Everyday Checking').id,
    'a bank statement does not land on a credit card',
  );
});

/* ── End to end ───────────────────────────────────────────────────────── */

test('a real encrypted statement imports and still reconciles', () => {
  const state = baseState();
  const card = account(state, 'BDO Visa');
  const checking = account(state, 'Everyday Checking');
  const groceries = category(state, 'Groceries');

  const bytes = new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures/bdo-card-aes256.pdf')));
  const parsed = parseStatement(readPdfText(bytes, '7788').lines, { today: new Date(2026, 6, 1) });

  const drafts = buildDrafts(state, parsed.rows, {
    accountId: card.id,
    memo: 'BDO statement 2026-06-18',
    paymentSourceId: checking.id,
  }).map((draft) => (draft.categoryId === null && draft.role === 'charge'
    ? { ...draft, categoryId: groceries.id }
    : draft));

  const totals = importTotals(drafts);
  assert.equal(totals.selected, 8, 'all eight rows selected');

  const next = applyImport(state, drafts, card.id);
  assertBalanced(next, 'imported BDO statement');

  // Charges add debt, the payment and the reversal take it away.
  const charges = 2_845_60 + 310_00 + 4_512_33 + 1_299_00 + 3_500_00 + 876_30;
  const credits = 8_120_45 + 3_500_00;
  assert.equal(accountBalance(next, card.id), -charges + credits);
  assert.equal(accountBalance(next, checking.id), 10_000_00 - 8_120_45, 'the payment left chequing');

  // Every imported row carries the statement it came from.
  const imported = next.transactions.filter((t) => t.memo === 'BDO statement 2026-06-18');
  assert.equal(imported.length, 9, 'eight rows, with the payment recorded as two legs');
  assert.ok(imported.every((t) => t.cleared), 'a statement row has settled by definition');
});

/* ── Checking the import against the statement ────────────────────────── */

test('an import that matches the statement says so', () => {
  const state = baseState();
  const card = account(state, 'BDO Visa');
  const checking = account(state, 'Everyday Checking');
  const { parsed } = bdoStatement();

  // The card was opened with the statement's *previous* balance, which is the
  // figure the statement's own rows start from.
  const opened = actions.updateAccount(state, card.id, {
    openingBalance: -must(parsed.summary.previousBalance, 'previous balance'),
  });
  const drafts = buildDrafts(opened, parsed.rows, {
    accountId: card.id,
    paymentSourceId: checking.id,
  });

  const check = must(
    reconcileWithStatement(opened, drafts, card.id, parsed.summary),
    'the reconciliation',
  );
  assert.equal(check.agrees, true);
  assert.equal(check.projected, parsed.summary.totalDue);
  assert.equal(check.difference, 0);
});

test('a starting balance taken from the statement is caught as a double count', () => {
  const state = baseState();
  const card = account(state, 'BDO Visa');
  const checking = account(state, 'Everyday Checking');
  const { parsed } = bdoStatement();
  const totalDue = must(parsed.summary.totalDue, 'total due');

  // What someone actually does: add the card with the balance owed *today*,
  // read off the statement they are about to import.
  const opened = actions.updateAccount(state, card.id, { openingBalance: -totalDue });
  const drafts = buildDrafts(opened, parsed.rows, {
    accountId: card.id,
    paymentSourceId: checking.id,
  });

  const check = must(reconcileWithStatement(opened, drafts, card.id, parsed.summary), 'the check');
  assert.equal(check.agrees, false);
  assert.equal(check.looksLikeDoubleCount, true, 'the gap is exactly what these rows move');

  // The suggested fix is the statement's previous balance — the figure the card
  // held before any of these rows happened.
  assert.equal(
    check.suggestedOpeningBalance,
    -must(parsed.summary.previousBalance, 'previous balance'),
  );

  // Applying it makes the two agree.
  const fixed = actions.updateAccount(opened, card.id, {
    openingBalance: check.suggestedOpeningBalance,
  });
  const after = must(reconcileWithStatement(fixed, drafts, card.id, parsed.summary), 'the recheck');
  assert.equal(after.agrees, true);
  assert.equal(accountBalance(applyImport(fixed, drafts, card.id), card.id), -totalDue);
});

test('a statement with no stated total has nothing to check against', () => {
  const state = baseState();
  const card = account(state, 'BDO Visa');
  const drafts = buildDrafts(state, [row({})], { accountId: card.id });
  assert.equal(
    reconcileWithStatement(state, drafts, card.id, { totalDue: null, statementDate: null }),
    null,
  );
});

/* ── Moving money between your own accounts ───────────────────────────── */

test('a row marked as a transfer moves money instead of spending it', () => {
  const state = baseState();
  const checking = account(state, 'Everyday Checking');
  let withSavings = actions.addAccount(state, {
    name: 'Savings', type: 'savings', openingBalance: 0, openedOn: '2026-06-01',
  });
  const savings = account(withSavings, 'Savings');

  const drafts = buildDrafts(withSavings, [row({ description: 'TRANSFER TO SAVINGS', amount: 5_000_00 })], {
    accountId: checking.id,
  }).map((draft) => ({ ...draft, role: 'transfer' as const, fromAccountId: savings.id, categoryId: null }));

  const next = applyImport(withSavings, drafts, checking.id);

  const legs = next.transactions.filter((t) => t.transferId);
  assert.equal(legs.length, 2, 'a transfer is a linked pair');
  assert.equal(accountBalance(next, checking.id), 10_000_00 - 5_000_00, 'it left chequing');
  assert.equal(accountBalance(next, savings.id), 5_000_00, 'and arrived in savings');
  // Neither leg is categorised: the money is still yours, so no envelope moved.
  assert.ok(legs.every((leg) => leg.categoryId === null));
  assertBalanced(next, 'imported transfer');
});

test('a transfer with no other account chosen is skipped, not guessed', () => {
  const state = baseState();
  const checking = account(state, 'Everyday Checking');
  const drafts = buildDrafts(state, [row({ description: 'TRANSFER OUT', amount: 5_000_00 })], {
    accountId: checking.id,
  }).map((draft) => ({ ...draft, role: 'transfer' as const, fromAccountId: null }));

  assert.equal(importTotals(drafts).selected, 0);
  assert.equal(importTotals(drafts).unassignedPayments, 1);
  const next = applyImport(state, drafts, checking.id);
  assert.equal(next.transactions.length, state.transactions.length);
});

test('an incoming row marked as a transfer arrives from the other account', () => {
  let state = baseState();
  state = actions.addAccount(state, {
    name: 'Savings', type: 'savings', openingBalance: 20_000_00, openedOn: '2026-06-01',
  });
  const checking = account(state, 'Everyday Checking');
  const savings = account(state, 'Savings');

  const drafts = buildDrafts(
    state,
    [row({ description: 'TRANSFER FROM SAVINGS', amount: 3_000_00, direction: 'credit' })],
    { accountId: checking.id },
  ).map((draft) => ({ ...draft, role: 'transfer' as const, fromAccountId: savings.id, categoryId: null }));

  const next = applyImport(state, drafts, checking.id);
  // Direction follows the sign: money arriving came *from* the other account.
  assert.equal(accountBalance(next, checking.id), 10_000_00 + 3_000_00);
  assert.equal(accountBalance(next, savings.id), 20_000_00 - 3_000_00);
  assertBalanced(next, 'incoming transfer');
});

test('a row naming one of your own accounts is read as moving money, not spending', () => {
  let state = baseState();
  state = actions.addAccount(state, {
    name: 'BPI Savings', type: 'savings', provider: 'BPI', openingBalance: 20_000_00,
    openedOn: '2026-06-01',
  });
  const checking = account(state, 'Everyday Checking');
  const savings = account(state, 'BPI Savings');
  const groceries = category(state, 'Groceries');

  // History that would otherwise hand this payee a category, so the assertion
  // below is about the role and not about there being nothing to guess.
  state = actions.addTransaction(state, {
    date: '2026-05-02', accountId: checking.id, categoryId: groceries.id,
    payee: 'FUND TRANSFER TO BPI SAVINGS', amount: -1_000_00, kind: 'expense',
  });

  const drafts = buildDrafts(
    state,
    [row({ description: 'FUND TRANSFER TO BPI SAVINGS', amount: 5_000_00 })],
    { accountId: checking.id },
  );
  assert.equal(drafts[0]?.role, 'transfer');
  assert.equal(drafts[0]?.fromAccountId, savings.id, 'the account it names is the other side');
  assert.equal(drafts[0]?.categoryId, null, 'moving your own money is not spending, so it needs no category');

  const next = applyImport(state, drafts, checking.id);
  const legs = next.transactions.filter((t) => t.transferId);
  assert.equal(legs.length, 2, 'a transfer is a linked pair');
  assert.ok(legs.every((leg) => leg.categoryId === null), 'neither leg is categorised');
  assert.equal(accountBalance(next, checking.id), 10_000_00 - 1_000_00 - 5_000_00);
  assert.equal(accountBalance(next, savings.id), 25_000_00);
  // Nothing was spent, so the month's spending and Ready to assign are untouched.
  assert.equal(buildLedger(next, MONTH).get(MONTH)?.unbudgeted, 0);
  assert.equal(reconcile(next, MONTH).readyToAssign, reconcile(state, MONTH).readyToAssign);
  assertBalanced(next, 'recognised transfer');
});

test('a move needs both the wording and an account you actually hold', () => {
  let state = baseState();
  state = actions.addAccount(state, {
    name: 'BPI Savings', type: 'savings', provider: 'BPI', openingBalance: 0, openedOn: '2026-06-01',
  });
  const checking = account(state, 'Everyday Checking');
  const drafts = buildDrafts(
    state,
    [
      // A movement, but to someone else's number: this money really did leave.
      row({ id: 'a', description: 'TRANSFER TO 09171234567' }),
      // Your bank's name on an ordinary charge is not a movement.
      row({ id: 'b', description: 'BPI SAVINGS ACCOUNT FEE' }),
    ],
    { accountId: checking.id },
  );
  assert.deepEqual(drafts.map((draft) => draft.role), ['expense', 'expense']);
  assert.ok(drafts.every((draft) => draft.fromAccountId === null));
});

test('a card payment takes its source from the account the row names', () => {
  let state = baseState();
  state = actions.addAccount(state, {
    name: 'BPI Savings', type: 'savings', provider: 'BPI', openingBalance: 20_000_00,
    openedOn: '2026-06-01',
  });
  const card = account(state, 'BDO Visa');
  const savings = account(state, 'BPI Savings');
  const checking = account(state, 'Everyday Checking');

  const drafts = buildDrafts(
    state,
    [row({ description: 'AUTO DEBIT PAYMENT FROM BPI SAVINGS', amount: 4_000_00, direction: 'credit' })],
    { accountId: card.id, paymentSourceId: checking.id },
  );
  assert.equal(drafts[0]?.role, 'payment', 'it is still a payment to the card');
  assert.equal(drafts[0]?.fromAccountId, savings.id, 'the statement said where it came from');

  const next = applyImport(state, drafts, card.id);
  assert.equal(accountBalance(next, savings.id), 20_000_00 - 4_000_00);
  assert.equal(accountBalance(next, checking.id), 10_000_00, 'the default source was left alone');
  assertBalanced(next, 'payment from the account it named');
});

test('uncategorised imported spending is reported, not silently absorbed', () => {
  const state = baseState();
  const checking = account(state, 'Everyday Checking');
  // A row nothing could be guessed for imports uncategorised. It still has to
  // add up: the cash left, so Ready to assign carries it.
  const drafts = buildDrafts(state, [row({ description: 'Unknown merchant', amount: 1_500_00 })], {
    accountId: checking.id,
  });
  assert.equal(drafts[0]?.categoryId, null);

  const next = applyImport(state, drafts, checking.id);
  assert.equal(buildLedger(next, MONTH).get(MONTH)?.unbudgeted, 1_500_00);
  assertBalanced(next, 'uncategorised import');
});
