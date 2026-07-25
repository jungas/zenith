/**
 * The budget engine, including the credit-card connection.
 * Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emptyState, paymentCategoryFor } from '../src/core/model.js';
import * as actions from '../src/core/actions.js';
import {
  accountBalance, buildLedger, cashOnHand, categoryRow, monthSummary, reconcile,
  spendingByCategory, totalDebt, queryTransactions,
} from '../src/core/budget.js';

const JAN = '2026-01';
const FEB = '2026-02';

/**
 * A chequing account with $1,000, one credit card, and a Groceries envelope.
 * This is the worked example documented at the top of core/budget.js.
 */
function fixture() {
  let state = emptyState(new Date('2026-01-01T00:00:00Z'));
  state = actions.addAccount(state, {
    name: 'Checking', type: 'checking', openingBalance: 100_000, openedOn: `${JAN}-01`,
  });
  state = actions.addAccount(state, {
    name: 'Visa', type: 'credit', openingBalance: 0, openedOn: `${JAN}-01`,
    creditLimit: 500_000, apr: 0.2, statementDay: 18, dueDay: 12,
  });
  state = actions.addCategory(state, { name: 'Groceries', group: 'Everyday' });
  state = actions.addCategory(state, { name: 'Dining', group: 'Everyday' });

  const checking = state.accounts.find((a) => a.name === 'Checking');
  const visa = state.accounts.find((a) => a.name === 'Visa');
  const groceries = state.categories.find((c) => c.name === 'Groceries');
  const dining = state.categories.find((c) => c.name === 'Dining');
  return { state, checking, visa, groceries, dining };
}

test('opening balances become budgetable income', () => {
  const { state } = fixture();
  assert.equal(cashOnHand(state), 100_000);
  assert.equal(monthSummary(state, JAN).readyToAssign, 100_000);
});

test('a credit card gets exactly one payment envelope, named after it', () => {
  const { state, visa } = fixture();
  const payment = paymentCategoryFor(state, visa.id);
  assert.ok(payment, 'payment category should exist');
  assert.equal(payment.name, 'Visa');
  assert.equal(payment.kind, 'ccPayment');
  assert.equal(
    state.categories.filter((c) => c.kind === 'ccPayment' && c.accountId === visa.id).length,
    1,
  );
});

test('spending on a card draws the category and reserves cash for the bill', () => {
  let { state, visa, groceries } = fixture();
  state = actions.setBudget(state, JAN, groceries.id, 20_000);
  state = actions.addTransaction(state, {
    date: `${JAN}-10`, accountId: visa.id, categoryId: groceries.id,
    payee: 'Market', amount: -5_000, kind: 'expense',
  });

  const summary = monthSummary(state, JAN);
  const payment = paymentCategoryFor(state, visa.id);

  // The envelope was spent from…
  assert.equal(categoryRow(summary, groceries.id).activity, -5_000);
  assert.equal(categoryRow(summary, groceries.id).available, 15_000);
  // …and the same amount is now held for the card.
  assert.equal(categoryRow(summary, payment.id).reserved, 5_000);
  assert.equal(categoryRow(summary, payment.id).available, 5_000);

  // The card owes it; no cash has actually moved.
  assert.equal(accountBalance(state, visa.id), -5_000);
  assert.equal(cashOnHand(state), 100_000);
  assert.equal(summary.readyToAssign, 80_000);
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('paying the card spends the payment envelope, not a category', () => {
  let { state, checking, visa, groceries } = fixture();
  state = actions.setBudget(state, JAN, groceries.id, 20_000);
  state = actions.addTransaction(state, {
    date: `${JAN}-10`, accountId: visa.id, categoryId: groceries.id, amount: -5_000, kind: 'expense',
  });
  state = actions.payCard(state, {
    cardId: visa.id, fromAccountId: checking.id, amount: 5_000, date: `${JAN}-20`,
  });

  const summary = monthSummary(state, JAN);
  const payment = paymentCategoryFor(state, visa.id);

  assert.equal(categoryRow(summary, payment.id).activity, -5_000);
  assert.equal(categoryRow(summary, payment.id).available, 0);
  // Groceries is untouched by the payment — the spending was budgeted already.
  assert.equal(categoryRow(summary, groceries.id).available, 15_000);

  assert.equal(accountBalance(state, visa.id), 0);
  assert.equal(accountBalance(state, checking.id), 95_000);
  assert.equal(summary.readyToAssign, 80_000);
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('a payment transfer creates two linked legs and only one is categorised', () => {
  let { state, checking, visa } = fixture();
  state = actions.payCard(state, {
    cardId: visa.id, fromAccountId: checking.id, amount: 7_500, date: `${JAN}-20`,
  });

  const legs = state.transactions.filter((t) => t.transferId);
  assert.equal(legs.length, 2);
  assert.equal(legs[0].transferId, legs[1].transferId);
  assert.equal(legs[0].amount + legs[1].amount, 0);

  const payment = paymentCategoryFor(state, visa.id);
  const categorised = legs.filter((leg) => leg.categoryId === payment.id);
  assert.equal(categorised.length, 1);
  assert.equal(categorised[0].accountId, checking.id, 'the outflow leg carries the category');
});

test('a transfer between asset accounts touches no category', () => {
  let { state, checking } = fixture();
  state = actions.addAccount(state, {
    name: 'Savings', type: 'savings', openingBalance: 0, openedOn: `${JAN}-01`,
  });
  const savings = state.accounts.find((a) => a.name === 'Savings');
  state = actions.addTransfer(state, {
    fromAccountId: checking.id, toAccountId: savings.id, amount: 25_000, date: `${JAN}-05`,
  });

  const summary = monthSummary(state, JAN);
  assert.equal(summary.readyToAssign, 100_000, 'moving cash is not income');
  for (const row of summary.rows.values()) assert.equal(row.activity, 0);
  assert.equal(accountBalance(state, savings.id), 25_000);
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('positive envelope balances roll forward, negatives do not', () => {
  let { state, checking, groceries, dining } = fixture();
  state = actions.setBudget(state, JAN, groceries.id, 20_000);
  state = actions.addTransaction(state, {
    date: `${JAN}-10`, accountId: checking.id, categoryId: groceries.id, amount: -5_000, kind: 'expense',
  });
  // Dining is unfunded and overspent by $30.
  state = actions.addTransaction(state, {
    date: `${JAN}-12`, accountId: checking.id, categoryId: dining.id, amount: -3_000, kind: 'expense',
  });

  const jan = monthSummary(state, JAN);
  assert.equal(categoryRow(jan, groceries.id).available, 15_000);
  assert.equal(categoryRow(jan, dining.id).available, -3_000);
  assert.equal(jan.overspent, 3_000);

  const ledger = buildLedger(state, FEB);
  const feb = ledger.get(FEB);
  assert.equal(categoryRow(feb, groceries.id).rollover, 15_000);
  assert.equal(categoryRow(feb, dining.id).rollover, 0, 'overspending does not roll forward');
  // Last month's overspending comes out of this month's Ready to assign.
  assert.equal(feb.readyToAssign, 100_000 - 20_000 - 3_000);
});

test('pre-existing card debt is not treated as income', () => {
  let state = emptyState(new Date('2026-01-01T00:00:00Z'));
  state = actions.addAccount(state, {
    name: 'Old Card', type: 'credit', openingBalance: -124_000, openedOn: `${JAN}-01`,
    creditLimit: 450_000, apr: 0.25,
  });

  const summary = monthSummary(state, JAN);
  assert.equal(summary.readyToAssign, 0, 'debt is not budgetable money');
  assert.equal(summary.income, 0);
  assert.equal(totalDebt(state), 124_000);

  const card = state.accounts[0];
  const payment = paymentCategoryFor(state, card.id);
  assert.equal(categoryRow(summary, payment.id).available, 0, 'nothing was ever set aside for it');
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('over-assigning drives Ready to assign negative', () => {
  let { state, groceries } = fixture();
  state = actions.setBudget(state, JAN, groceries.id, 150_000);
  assert.equal(monthSummary(state, JAN).readyToAssign, -50_000);
});

test('moving money between envelopes conserves the total assigned', () => {
  let { state, groceries, dining } = fixture();
  state = actions.setBudget(state, JAN, groceries.id, 20_000);
  state = actions.moveBudget(state, JAN, groceries.id, dining.id, 8_000);

  const summary = monthSummary(state, JAN);
  assert.equal(categoryRow(summary, groceries.id).budgeted, 12_000);
  assert.equal(categoryRow(summary, dining.id).budgeted, 8_000);
  assert.equal(summary.budgeted, 20_000);
  assert.equal(summary.readyToAssign, 80_000);
});

test('deleting an account removes both legs of its transfers', () => {
  let { state, checking, visa } = fixture();
  state = actions.payCard(state, {
    cardId: visa.id, fromAccountId: checking.id, amount: 5_000, date: `${JAN}-20`,
  });
  assert.equal(state.transactions.length, 2);

  state = actions.deleteAccount(state, visa.id);
  assert.equal(state.transactions.length, 0, 'a half-transfer would unbalance every total');
  assert.equal(paymentCategoryFor(state, visa.id), null);
  assert.equal(reconcile(state, JAN).balanced, true);
});

test('deleting a category keeps history but uncategorises it', () => {
  let { state, checking, groceries } = fixture();
  state = actions.addTransaction(state, {
    date: `${JAN}-10`, accountId: checking.id, categoryId: groceries.id, amount: -5_000, kind: 'expense',
  });
  state = actions.deleteCategory(state, groceries.id);

  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].categoryId, null);
  assert.equal(accountBalance(state, checking.id), 95_000);
});

test('a card payment envelope cannot be deleted on its own', () => {
  const { state, visa } = fixture();
  const payment = paymentCategoryFor(state, visa.id);
  const next = actions.deleteCategory(state, payment.id);
  assert.equal(next, state, 'structural envelopes are managed with their card');
});

test('spending totals ignore transfers and income', () => {
  let { state, checking, visa, groceries } = fixture();
  state = actions.addTransaction(state, {
    date: `${JAN}-03`, accountId: checking.id, amount: 250_000, kind: 'income', payee: 'Salary',
  });
  state = actions.addTransaction(state, {
    date: `${JAN}-10`, accountId: visa.id, categoryId: groceries.id, amount: -5_000, kind: 'expense',
  });
  state = actions.payCard(state, {
    cardId: visa.id, fromAccountId: checking.id, amount: 5_000, date: `${JAN}-20`,
  });

  const spending = spendingByCategory(state, JAN, JAN);
  assert.equal(spending.get(groceries.id), 5_000);

  const summary = monthSummary(state, JAN);
  assert.equal(summary.spending, 5_000, 'the card payment is not extra spending');
  // Opening balances are budgetable, but they are not income — reporting them
  // as such would put a spike in the first month of every trend chart.
  assert.equal(summary.income, 250_000);
  assert.equal(summary.startingFunds, 100_000);
  assert.equal(summary.readyToAssign, 350_000, 'both are still yours to assign');
});

test('the ledger exposes synthetic opening balances but marks them read-only', () => {
  const { state, checking } = fixture();
  const rows = queryTransactions(state, { accountId: checking.id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].system, true);
  assert.equal(rows[0].amount, 100_000);
});

test('CSV export escapes quotes in user text', () => {
  let { state, checking } = fixture();
  state = actions.addTransaction(state, {
    date: `${JAN}-10`, accountId: checking.id, payee: 'The "Best" Cafe', amount: -1_234, kind: 'expense',
  });
  const csv = actions.toCsv(state);
  assert.match(csv, /"The ""Best"" Cafe"/);
  assert.match(csv, /"-12\.34"/);
});

test('a backup round-trips', () => {
  let { state, groceries } = fixture();
  state = actions.setBudget(state, JAN, groceries.id, 20_000);
  const restored = actions.fromBackup(actions.toBackup(state));
  assert.deepEqual(restored.budgets, state.budgets);
  assert.equal(restored.accounts.length, state.accounts.length);
  assert.equal(monthSummary(restored, JAN).readyToAssign, monthSummary(state, JAN).readyToAssign);
});

test('a malformed backup is rejected with a readable message', () => {
  assert.throws(() => actions.fromBackup('{"nope":true}'), /missing "accounts"/);
});
