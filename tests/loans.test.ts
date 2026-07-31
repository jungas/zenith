/**
 * Loan accounts.
 *
 * A loan is the mirror image of a credit card: its balance only falls, and its
 * payment envelope has to be filled deliberately rather than filling itself as
 * you spend. What the two share is the thing that matters most here — paying
 * either one moves cash out of an asset account into a liability, and without
 * an envelope falling to match, the identity in `core/budget.ts` would not hold.
 *
 * So most of this file is that identity, checked at each step of a loan's life.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as actions from '../src/core/actions.ts';
import { emptyState, isDebt, isLoan, paymentCategoryFor } from '../src/core/model.ts';
import type { AppState, LoanAccount } from '../src/core/model.ts';
import {
  accountBalance, cashOnHand, monthSummary, netWorth, reconcile, totalDebt, totalOwed,
} from '../src/core/budget.ts';
import { loanSnapshot, loanTotals, upcomingLoanPayments } from '../src/core/loans.ts';
import { account, must } from './helpers.ts';

const JUN = '2026-06';

/** Chequing with ₱100,000, and a ₱500,000 car loan over 48 months. */
function fixture(): AppState {
  let state = emptyState(new Date(2026, 5, 1));
  state = actions.addAccount(state, {
    name: 'Chequing', type: 'checking', openingBalance: 100_000_00, openedOn: '2026-06-01',
  });
  state = actions.addAccount(state, {
    name: 'Auto loan', type: 'loan', kind: 'Auto loan', provider: 'BPI',
    openingBalance: -500_000_00, openedOn: '2026-06-01',
    principal: 500_000_00, apr: 0.12, monthlyPayment: 12_000_00,
    termMonths: 48, dueDay: 5, startMonth: JUN,
  });
  return state;
}

const loanOf = (state: AppState): LoanAccount => {
  const found = account(state, 'Auto loan');
  if (!isLoan(found)) throw new Error('not a loan');
  return found;
};

const assertBalanced = (state: AppState, what: string): void => {
  const check = reconcile(state, JUN);
  assert.ok(check.balanced, `${what}: out by ${check.difference}`);
};

/* ── It is debt, not cash ─────────────────────────────────────────────── */

test('a loan is a liability, and what it owes was never income', () => {
  const state = fixture();
  const loan = loanOf(state);

  assert.ok(isDebt(loan));
  assert.equal(cashOnHand(state), 100_000_00, 'borrowing did not add to spendable cash');
  assert.equal(netWorth(state), 100_000_00 - 500_000_00);
  assert.equal(accountBalance(state, loan.id), -500_000_00);

  // The opening balance is money already owed. Treating it as income would put
  // half a million pesos into Ready to assign that nobody can spend.
  assert.equal(monthSummary(state, JUN).readyToAssign, 100_000_00);
  assertBalanced(state, 'a new loan');
});

test('a loan owns a payment envelope, in its own group', () => {
  const state = fixture();
  const envelope = must(paymentCategoryFor(state, loanOf(state).id), 'the payment envelope');
  assert.equal(envelope.name, 'Auto loan');
  assert.equal(envelope.group, 'Loan payments');
});

test('totals separate card debt from everything owed', () => {
  let state = fixture();
  state = actions.addAccount(state, {
    name: 'Visa', type: 'credit', openingBalance: -20_000_00, openedOn: '2026-06-01', creditLimit: 100_000_00,
  });
  assert.equal(totalDebt(state), 20_000_00, 'cards only');
  assert.equal(totalOwed(state), 520_000_00, 'cards and loans');
});

/* ── Paying it ────────────────────────────────────────────────────────── */

test('paying a loan spends its envelope and keeps the budget in step', () => {
  let state = fixture();
  const loan = loanOf(state);
  const chequing = account(state, 'Chequing');
  const envelope = must(paymentCategoryFor(state, loan.id), 'the envelope');

  // Budget the monthly amount, then pay it.
  state = actions.setBudget(state, JUN, envelope.id, 12_000_00);
  assertBalanced(state, 'after budgeting');
  assert.equal(loanSnapshot(state, loanOf(state), { month: JUN }).readyForNextPayment, true);

  state = actions.addTransfer(state, {
    fromAccountId: chequing.id, toAccountId: loan.id, amount: 12_000_00, date: '2026-06-05',
  });

  assert.equal(cashOnHand(state), 100_000_00 - 12_000_00);
  assert.equal(accountBalance(state, loan.id), -488_000_00, 'the loan owes less');
  // The outflow leg is categorised to the loan's envelope: that is what keeps
  // cash and the budget moving together.
  const outflow = must(
    state.transactions.find((t) => t.accountId === chequing.id && t.transferId),
    'the outflow leg',
  );
  assert.equal(outflow.categoryId, envelope.id);
  assertBalanced(state, 'after paying');
});

test('payLoan records a manual payment the same way a transfer would', () => {
  let state = fixture();
  const loan = loanOf(state);
  const chequing = account(state, 'Chequing');
  const envelope = must(paymentCategoryFor(state, loan.id), 'the envelope');

  state = actions.setBudget(state, JUN, envelope.id, 12_000_00);
  state = actions.payLoan(state, {
    loanId: loan.id, fromAccountId: chequing.id, amount: 12_000_00, date: '2026-06-05', memo: 'June instalment',
  });

  assert.equal(cashOnHand(state), 100_000_00 - 12_000_00);
  assert.equal(accountBalance(state, loan.id), -488_000_00, 'the loan owes less');
  const outflow = must(
    state.transactions.find((t) => t.accountId === chequing.id && t.transferId),
    'the outflow leg',
  );
  assert.equal(outflow.categoryId, envelope.id, 'the envelope is spent, same as any other loan payment');
  assert.equal(outflow.memo, 'June instalment');
  assertBalanced(state, 'after payLoan');
});

test('an unbudgeted loan payment still adds up', () => {
  // Nobody budgeted for it, so the envelope goes negative — but the identity
  // holds either way, which is the whole point of routing it through one.
  let state = fixture();
  state = actions.addTransfer(state, {
    fromAccountId: account(state, 'Chequing').id,
    toAccountId: loanOf(state).id,
    amount: 12_000_00,
    date: '2026-06-05',
  });
  assertBalanced(state, 'unbudgeted loan payment');
});

/* ── Progress ─────────────────────────────────────────────────────────── */

test('a loan reports where it is and what it costs', () => {
  let state = fixture();
  state = actions.addTransfer(state, {
    fromAccountId: account(state, 'Chequing').id,
    toAccountId: loanOf(state).id,
    amount: 12_000_00,
    date: '2026-06-05',
  });

  const snapshot = loanSnapshot(state, loanOf(state), { month: JUN, asOf: '2026-06-20' });
  assert.equal(snapshot.balance, 488_000_00);
  assert.equal(snapshot.repaid, 12_000_00);
  assert.equal(snapshot.paymentsMade, 1);
  assert.equal(snapshot.paymentsRemaining, 47);
  assert.equal(snapshot.finalMonth, '2030-05');
  assert.equal(snapshot.remainingToPay, 47 * 12_000_00);
  // 48 × 12,000 = 576,000 against 500,000 borrowed.
  assert.equal(snapshot.totalInterest, 76_000_00);
  // The due day has passed this month, so the next one is in July.
  assert.equal(snapshot.nextDueDate, '2026-07-05');
});

test('progress is derived, so a later month reads further along', () => {
  const state = fixture();
  assert.equal(loanSnapshot(state, loanOf(state), { month: JUN }).paymentsMade, 1);
  assert.equal(loanSnapshot(state, loanOf(state), { month: '2027-06' }).paymentsMade, 13);
  // Never past the end of its own term.
  assert.equal(loanSnapshot(state, loanOf(state), { month: '2040-01' }).paymentsMade, 48);
  assert.equal(loanSnapshot(state, loanOf(state), { month: '2040-01' }).paymentsRemaining, 0);
  // Nor before it began.
  assert.equal(loanSnapshot(state, loanOf(state), { month: '2026-01' }).paymentsMade, 0);
});

test('totals say what every loan commits you to each month', () => {
  let state = fixture();
  state = actions.addAccount(state, {
    name: 'SSS salary loan', type: 'loan', openingBalance: -30_000_00, openedOn: '2026-06-01',
    principal: 30_000_00, monthlyPayment: 2_500_00, termMonths: 12, dueDay: 20, startMonth: JUN,
  });

  const totals = loanTotals(state, { month: JUN, asOf: '2026-06-01' });
  assert.equal(totals.balance, 530_000_00);
  assert.equal(totals.monthly, 14_500_00);
  assert.equal(totals.unfunded, 2, 'neither envelope holds its payment yet');
  assert.deepEqual(totals.loans.map((l) => l.loan.name), ['Auto loan', 'SSS salary loan']);
});

test('a settled loan stops being a monthly commitment', () => {
  let state = fixture();
  // Pay it off outright.
  state = actions.addTransfer(state, {
    fromAccountId: account(state, 'Chequing').id,
    toAccountId: loanOf(state).id,
    amount: 500_000_00,
    date: '2026-06-05',
  });
  const totals = loanTotals(state, { month: JUN });
  assert.equal(totals.balance, 0);
  assert.equal(totals.monthly, 0, 'nothing owed, nothing committed');
  assert.deepEqual(upcomingLoanPayments(state, { asOf: '2026-06-01' }), []);
  assertBalanced(state, 'settled loan');
});

/* ── The type is kept honest ──────────────────────────────────────────── */

test('loan terms do not leak onto other account types, or card terms onto a loan', () => {
  let state = fixture();
  // A chequing account handed loan terms keeps none of them.
  state = actions.addAccount(state, {
    name: 'Savings', type: 'savings', monthlyPayment: 999_00, termMonths: 12, principal: 5_000_00,
  });
  const savings = account(state, 'Savings');
  assert.equal('monthlyPayment' in savings, false);
  assert.equal('termMonths' in savings, false);

  // And a loan handed card terms keeps none of those.
  const loan = loanOf(state);
  assert.equal('creditLimit' in loan, false);
  assert.equal('statementDay' in loan, false);
  assert.equal('minPaymentFloor' in loan, false);
});

test('a loan survives a backup round trip', () => {
  const restored = actions.fromBackup(actions.toBackup(fixture()));
  const loan = loanOf(restored);
  assert.equal(loan.principal, 500_000_00);
  assert.equal(loan.termMonths, 48);
  assert.equal(loan.startMonth, JUN);
  assert.ok(paymentCategoryFor(restored, loan.id), 'its envelope came back too');
  assertBalanced(restored, 'restored loan');
});

test('deleting a loan takes its envelope with it', () => {
  const state = fixture();
  const loan = loanOf(state);
  const next = actions.deleteAccount(state, loan.id);
  assert.equal(paymentCategoryFor(next, loan.id), null);
  assert.equal(next.accounts.some(isLoan), false);
  assertBalanced(next, 'after deleting the loan');
});
