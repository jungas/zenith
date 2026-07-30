/**
 * Digital wallets, and the transfer fees that come with them.
 *
 * The thing worth pinning here is that a fee is *spending*, not an adjustment:
 * it has to leave the budget through a category, or the reconciliation identity
 * silently stops holding.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emptyState, isAsset, isCredit, isWallet } from '../src/core/model.ts';
import type { AppState } from '../src/core/model.ts';
import * as actions from '../src/core/actions.ts';
import {
  accountBalance, cashOnHand, categoryRow, monthSummary, reconcile, spendingByCategory,
} from '../src/core/budget.ts';
import { formatMoney, parseMoney } from '../src/core/money.ts';
import { account, category, paymentEnvelope } from './helpers.ts';

const JAN = '2026-01';

function fixture() {
  let state: AppState = emptyState(new Date('2026-01-01T00:00:00Z'));
  state = actions.addAccount(state, {
    name: 'Checking', type: 'checking', openingBalance: 500_000, openedOn: `${JAN}-01`,
  });
  state = actions.addAccount(state, {
    name: 'GCash', type: 'wallet', provider: 'GCash', openingBalance: 20_000, openedOn: `${JAN}-01`,
  });
  state = actions.addCategory(state, { name: 'Groceries', group: 'Everyday' });
  state = actions.addCategory(state, { name: 'Fees', group: 'Bills' });
  return {
    state,
    checking: account(state, 'Checking'),
    gcash: account(state, 'GCash'),
    groceries: category(state, 'Groceries'),
    fees: category(state, 'Fees'),
  };
}

test('a wallet is an asset account, not a card', () => {
  const { state, gcash } = fixture();
  assert.equal(isWallet(gcash), true);
  assert.equal(isAsset(gcash), true);
  assert.equal(isCredit(gcash), false);
  // No payment envelope: a wallet holds money, it does not create debt.
  assert.equal(state.categories.filter((c) => c.kind === 'ccPayment').length, 0);
});

test('wallet money counts as cash you can budget', () => {
  const { state } = fixture();
  assert.equal(cashOnHand(state), 520_000, 'chequing plus wallet');
  assert.equal(monthSummary(state, JAN).readyToAssign, 520_000);
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('the provider is kept, and stripped card terms cannot sneak in', () => {
  const { gcash } = fixture();
  assert.equal(gcash.provider, 'GCash');
  assert.equal('creditLimit' in gcash, false);
});

test('spending from a wallet draws down its category, like cash', () => {
  let { state, gcash, groceries } = fixture();
  state = actions.setBudget(state, JAN, groceries.id, 30_000);
  state = actions.addTransaction(state, {
    date: `${JAN}-08`, accountId: gcash.id, categoryId: groceries.id,
    payee: 'Sari-sari store', amount: -5_000, kind: 'expense',
  });

  const summary = monthSummary(state, JAN);
  assert.equal(categoryRow(summary, groceries.id).available, 25_000);
  assert.equal(accountBalance(state, gcash.id), 15_000);
  assert.equal(summary.spending, 5_000);
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('topping up a wallet is not spending', () => {
  let { state, checking, gcash } = fixture();
  state = actions.addTransfer(state, {
    fromAccountId: checking.id, toAccountId: gcash.id, amount: 100_000, date: `${JAN}-05`,
  });

  const summary = monthSummary(state, JAN);
  assert.equal(accountBalance(state, checking.id), 400_000);
  assert.equal(accountBalance(state, gcash.id), 120_000);
  assert.equal(summary.spending, 0, 'moving your own money is not spending');
  assert.equal(cashOnHand(state), 520_000, 'and it does not change how much you hold');
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('a cash-out fee is categorised spending, and the budget still reconciles', () => {
  let { state, checking, gcash, fees } = fixture();
  state = actions.setBudget(state, JAN, fees.id, 5_000);
  state = actions.addTransfer(state, {
    fromAccountId: gcash.id, toAccountId: checking.id, amount: 10_000,
    date: `${JAN}-09`, fee: 200, feeCategoryId: fees.id,
  });

  // The wallet paid the amount moved *and* the fee.
  assert.equal(accountBalance(state, gcash.id), 20_000 - 10_000 - 200);
  assert.equal(accountBalance(state, checking.id), 510_000);
  // Cash really did fall by the fee — that money is gone.
  assert.equal(cashOnHand(state), 520_000 - 200);

  const summary = monthSummary(state, JAN);
  assert.equal(categoryRow(summary, fees.id).activity, -200);
  assert.equal(categoryRow(summary, fees.id).available, 4_800);
  assert.equal(summary.spending, 200, 'only the fee is spending');
  assert.equal(spendingByCategory(state, JAN, JAN).get(fees.id), 200);
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('a fee with no category is refused rather than left uncategorised', () => {
  let { state, checking, gcash } = fixture();
  state = actions.addTransfer(state, {
    fromAccountId: gcash.id, toAccountId: checking.id, amount: 10_000,
    date: `${JAN}-09`, fee: 200, feeCategoryId: null,
  });

  assert.equal(state.transactions.length, 2, 'the transfer legs only');
  // Better to drop the fee than to move money the budget cannot see.
  assert.equal(cashOnHand(state), 520_000);
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('deleting a transfer takes its fee with it', () => {
  let { state, checking, gcash, fees } = fixture();
  state = actions.addTransfer(state, {
    fromAccountId: gcash.id, toAccountId: checking.id, amount: 10_000,
    date: `${JAN}-09`, fee: 200, feeCategoryId: fees.id,
  });
  assert.equal(state.transactions.length, 3);

  const leg = state.transactions.find((t) => t.kind === 'transfer');
  state = actions.deleteTransaction(state, leg!.id);

  assert.equal(state.transactions.length, 0, 'no orphan fee left behind');
  assert.equal(cashOnHand(state), 520_000);
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('editing a transfer amount leaves the fee alone', () => {
  let { state, checking, gcash, fees } = fixture();
  state = actions.addTransfer(state, {
    fromAccountId: gcash.id, toAccountId: checking.id, amount: 10_000,
    date: `${JAN}-09`, fee: 200, feeCategoryId: fees.id,
  });

  const outflow = state.transactions.find((t) => t.kind === 'transfer' && t.amount < 0);
  state = actions.updateTransaction(state, outflow!.id, { amount: -30_000 });

  const legs = state.transactions.filter((t) => t.kind === 'transfer');
  assert.equal(legs.reduce((total, t) => total + t.amount, 0), 0, 'legs still mirror');
  assert.equal(Math.abs(legs[0]!.amount), 30_000);

  const fee = state.transactions.find((t) => t.kind === 'expense');
  assert.equal(fee?.amount, -200, 'the fee kept its own amount');
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('a fee also rides along when the date changes', () => {
  let { state, checking, gcash, fees } = fixture();
  state = actions.addTransfer(state, {
    fromAccountId: gcash.id, toAccountId: checking.id, amount: 10_000,
    date: `${JAN}-09`, fee: 200, feeCategoryId: fees.id,
  });

  const outflow = state.transactions.find((t) => t.kind === 'transfer' && t.amount < 0);
  state = actions.updateTransaction(state, outflow!.id, { date: `${JAN}-15` });

  for (const tx of state.transactions) {
    assert.equal(tx.date, `${JAN}-15`, `${tx.payee} should have moved with the transfer`);
  }
});

test('a posting date corrected on one leg travels across the transfer', () => {
  let { state, checking, gcash, fees } = fixture();
  state = actions.addTransfer(state, {
    fromAccountId: gcash.id, toAccountId: checking.id, amount: 10_000,
    date: `${JAN}-09`, postedDate: `${JAN}-09`, fee: 200, feeCategoryId: fees.id,
  });
  assert.ok(
    state.transactions.every((tx) => tx.postedDate === `${JAN}-09`),
    'one movement, one posting date — legs and fee alike',
  );

  const outflow = state.transactions.find((t) => t.kind === 'transfer' && t.amount < 0);
  state = actions.updateTransaction(state, outflow!.id, { postedDate: `${JAN}-12` });

  // The bank posted this once, so a corrected posting date belongs to both legs.
  // Leaving the mirror behind would let the other account's statement import the
  // same movement a second time.
  for (const tx of state.transactions) {
    assert.equal(tx.postedDate, `${JAN}-12`, `${tx.payee} should carry the corrected posting date`);
    assert.equal(tx.date, `${JAN}-09`, 'the date the money moved is untouched');
  }
});

/* ── Editing a transfer ───────────────────────────────────────────────── */

test('editing a transfer changes it rather than recording a second one', () => {
  let { state, checking, gcash } = fixture();
  state = actions.addTransfer(state, {
    fromAccountId: checking.id, toAccountId: gcash.id, amount: 10_000, date: `${JAN}-09`,
  });
  const transferId = state.transactions[0]?.transferId;

  state = actions.updateTransfer(state, transferId!, { amount: 25_000, date: `${JAN}-11` });

  // One movement, still two legs — not four.
  assert.equal(state.transactions.length, 2);
  const legs = state.transactions.filter((t) => t.kind === 'transfer');
  assert.equal(legs.reduce((total, t) => total + t.amount, 0), 0, 'the legs still mirror');
  assert.equal(accountBalance(state, checking.id), 500_000 - 25_000);
  assert.equal(accountBalance(state, gcash.id), 20_000 + 25_000);
  assert.ok(legs.every((leg) => leg.date === `${JAN}-11`));
  // The legs keep their ids, so anything holding a reference still points at them.
  assert.deepEqual(
    legs.map((leg) => leg.id).sort(),
    state.transactions.map((t) => t.id).sort(),
  );
  assert.equal(cashOnHand(state), 520_000, 'moving your own money changes no total');
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('redirecting a transfer at a card makes it a card payment', () => {
  let { state, checking, gcash } = fixture();
  state = actions.addAccount(state, {
    name: 'BDO Visa', type: 'credit', provider: 'BDO', openingBalance: -40_000,
    openedOn: `${JAN}-01`, creditLimit: 1_000_000,
  });
  const card = account(state, 'BDO Visa');
  const envelope = paymentEnvelope(state, card.id);

  state = actions.addTransfer(state, {
    fromAccountId: checking.id, toAccountId: gcash.id, amount: 10_000, date: `${JAN}-09`,
  });
  const transferId = state.transactions.find((t) => t.kind === 'transfer')?.transferId;
  assert.ok(state.transactions.every((t) => t.categoryId === null), 'a wallet top-up is uncategorised');

  // It was not a top-up: it paid the card. The destination decides the category,
  // so the outflow leg now spends the card's payment envelope.
  state = actions.updateTransfer(state, transferId!, { toAccountId: card.id });

  const outflow = state.transactions.find((t) => t.kind === 'transfer' && t.amount < 0);
  const inflow = state.transactions.find((t) => t.kind === 'transfer' && t.amount > 0);
  assert.equal(outflow?.categoryId, envelope.id, 'paying a debt spends its envelope');
  assert.equal(inflow?.accountId, card.id);
  assert.equal(inflow?.categoryId, null);
  assert.equal(accountBalance(state, gcash.id), 20_000, 'the wallet was left out of it');
  assert.equal(accountBalance(state, card.id), -30_000, 'the card owes 10,000 less');
  assert.equal(reconcile(state, JAN).balanced, true);

  // And back again: away from the card, the envelope is given up.
  state = actions.updateTransfer(state, transferId!, { toAccountId: gcash.id });
  assert.equal(
    state.transactions.find((t) => t.kind === 'transfer' && t.amount < 0)?.categoryId,
    null,
  );
  assert.equal(accountBalance(state, card.id), -40_000);
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('editing a transfer leaves its fee owning its own amount and category', () => {
  let { state, checking, gcash, fees, groceries } = fixture();
  state = actions.addTransfer(state, {
    fromAccountId: gcash.id, toAccountId: checking.id, amount: 10_000,
    date: `${JAN}-09`, fee: 200, feeCategoryId: fees.id,
  });
  const transferId = state.transactions[0]?.transferId;

  state = actions.updateTransfer(state, transferId!, { amount: 15_000, date: `${JAN}-14` });

  const fee = state.transactions.find((t) => t.kind === 'expense');
  assert.equal(fee?.amount, -200, 'the fee is spending in its own right');
  assert.equal(fee?.categoryId, fees.id, 'and keeps the envelope it came out of');
  assert.notEqual(fee?.categoryId, groceries.id);
  assert.equal(fee?.date, `${JAN}-14`, 'it only follows the date');
  assert.equal(cashOnHand(state), 520_000 - 200);
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('a transfer cannot be edited into one that moves nothing', () => {
  let { state, checking, gcash } = fixture();
  state = actions.addTransfer(state, {
    fromAccountId: checking.id, toAccountId: gcash.id, amount: 10_000, date: `${JAN}-09`,
  });
  const transferId = state.transactions[0]?.transferId;

  // The same account on both sides, or nothing moved: refused rather than stored,
  // exactly as when one is created.
  assert.equal(actions.updateTransfer(state, transferId!, { toAccountId: checking.id }), state);
  assert.equal(actions.updateTransfer(state, transferId!, { amount: 0 }), state);
  assert.equal(actions.updateTransfer(state, 'xfer_nothing', { amount: 500 }), state);
});

test('pesos format and parse', () => {
  const opts = { currency: 'PHP', locale: 'en-PH' };
  assert.equal(formatMoney(123_456, opts), '₱1,234.56');
  assert.equal(formatMoney(-5_000, opts), '-₱50.00');
  assert.equal(formatMoney(123_456, { ...opts, cents: false }), '₱1,235');
  // The symbol is stripped on the way back in.
  assert.equal(parseMoney('₱1,234.56'), 123_456);
});
