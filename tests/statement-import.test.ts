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
  applyImport, buildDrafts, guessCategoryId, importTotals, normalisePayee, suggestAccountId,
} from '../src/core/statement-import.ts';
import { account, category, must, paymentEnvelope } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MONTH = '2026-06';

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
