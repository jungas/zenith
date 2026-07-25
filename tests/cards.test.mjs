/** Credit-card maths: coverage, cycles, minimums, payoff projections. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emptyState } from '../src/core/model.js';
import * as actions from '../src/core/actions.js';
import {
  cardBalance, cardSnapshot, debtSummary, minimumPayment, payoffComparison,
  payoffSchedule, statementCycle, upcomingPayments, utilizationBand,
} from '../src/core/cards.js';
import { reconcile } from '../src/core/budget.js';
import { seedState } from '../src/core/seed.js';
import { nextDayOfMonth, daysBetween, addMonths, monthRange } from '../src/core/dates.js';
import { parseMoney, formatMoney, formatMoneyCompact } from '../src/core/money.js';

const JAN = '2026-01';

function withCard(patch = {}) {
  let state = emptyState(new Date('2026-01-01T00:00:00Z'));
  state = actions.addAccount(state, {
    name: 'Checking', type: 'checking', openingBalance: 500_000, openedOn: `${JAN}-01`,
  });
  state = actions.addAccount(state, {
    name: 'Visa', type: 'credit', openingBalance: 0, openedOn: `${JAN}-01`,
    creditLimit: 400_000, apr: 0.2199, statementDay: 18, dueDay: 12,
    minPaymentRate: 0.02, minPaymentFloor: 3_500, ...patch,
  });
  state = actions.addCategory(state, { name: 'Groceries', group: 'Everyday' });
  return {
    state,
    checking: state.accounts.find((a) => a.name === 'Checking'),
    visa: state.accounts.find((a) => a.name === 'Visa'),
    groceries: state.categories.find((c) => c.name === 'Groceries'),
  };
}

test('utilisation bands report a status and an icon, never colour alone', () => {
  for (const band of [
    utilizationBand(null),
    utilizationBand(0.1),
    utilizationBand(0.35),
    utilizationBand(0.55),
    utilizationBand(0.8),
    utilizationBand(1.2),
  ]) {
    assert.ok(band.label, 'has a word');
    assert.ok(band.icon, 'has an icon');
    assert.ok(band.status, 'has a status');
  }
  assert.equal(utilizationBand(0.1).key, 'good');
  assert.equal(utilizationBand(0.35).key, 'watch');
  assert.equal(utilizationBand(1.2).key, 'over');
});

test('utilisation and available credit follow the balance', () => {
  let { state, visa, groceries } = withCard();
  state = actions.addTransaction(state, {
    date: `${JAN}-05`, accountId: visa.id, categoryId: groceries.id, amount: -100_000, kind: 'expense',
  });

  const snap = cardSnapshot(state, state.accounts.find((a) => a.id === visa.id), { month: JAN });
  assert.equal(snap.balance, 100_000);
  assert.equal(cardBalance(state, visa.id), 100_000);
  assert.equal(snap.availableCredit, 300_000);
  assert.equal(snap.utilization, 0.25);
  assert.equal(snap.band.key, 'good');
});

test('card spending is fully funded by the budget, so coverage is complete', () => {
  let { state, visa, groceries } = withCard();
  state = actions.setBudget(state, JAN, groceries.id, 60_000);
  state = actions.addTransaction(state, {
    date: `${JAN}-05`, accountId: visa.id, categoryId: groceries.id, amount: -40_000, kind: 'expense',
  });

  const snap = cardSnapshot(state, state.accounts.find((a) => a.id === visa.id), { month: JAN });
  assert.equal(snap.reserved, 40_000);
  assert.equal(snap.uncovered, 0);
  assert.equal(snap.covered, true);
  assert.equal(snap.coverageRatio, 1);
  assert.equal(snap.monthlyInterestCost, 0, 'nothing unfunded means nothing accruing');
});

test('debt that predates the budget shows as uncovered, with an interest cost', () => {
  const { state, visa } = withCard({ openingBalance: -200_000 });
  const snap = cardSnapshot(state, state.accounts.find((a) => a.id === visa.id), { month: JAN });

  assert.equal(snap.balance, 200_000);
  assert.equal(snap.reserved, 0);
  assert.equal(snap.uncovered, 200_000);
  assert.equal(snap.covered, false);
  // 200000 cents × 21.99% / 12 ≈ 3665 cents
  assert.equal(snap.monthlyInterestCost, Math.round(200_000 * (0.2199 / 12)));
});

test('assigning money to the payment envelope closes the shortfall', () => {
  let { state, visa } = withCard({ openingBalance: -200_000 });
  const payment = state.categories.find((c) => c.kind === 'ccPayment');
  state = actions.setBudget(state, JAN, payment.id, 200_000);

  const snap = cardSnapshot(state, state.accounts.find((a) => a.id === visa.id), { month: JAN });
  assert.equal(snap.reserved, 200_000);
  assert.equal(snap.uncovered, 0);
  assert.equal(snap.covered, true);
});

test('minimum payment takes the greater of the floor and the rate', () => {
  const { visa } = withCard();
  assert.equal(minimumPayment(visa, 0), 0);
  assert.equal(minimumPayment(visa, 100_000), 3_500, 'floor wins on a small balance');
  assert.equal(minimumPayment(visa, 500_000), 10_000, 'rate wins on a large balance');
  assert.equal(minimumPayment(visa, 1_000), 1_000, 'never more than the balance');
});

test('the statement cycle puts the due date after the close date', () => {
  const { visa } = withCard();
  const cycle = statementCycle(visa, '2026-01-20');
  assert.equal(cycle.lastClose, '2026-01-18');
  assert.equal(cycle.nextClose, '2026-02-18');
  assert.ok(cycle.dueDate > cycle.lastClose, 'due after the statement it belongs to');
  assert.equal(cycle.dueDate, '2026-02-12');
  assert.equal(cycle.daysUntilDue, daysBetween('2026-01-20', '2026-02-12'));
});

test('a statement balance excludes charges made after the close', () => {
  let { state, visa, groceries } = withCard();
  state = actions.addTransaction(state, {
    date: '2026-01-10', accountId: visa.id, categoryId: groceries.id, amount: -30_000, kind: 'expense',
  });
  state = actions.addTransaction(state, {
    date: '2026-01-25', accountId: visa.id, categoryId: groceries.id, amount: -12_000, kind: 'expense',
  });

  const snap = cardSnapshot(state, state.accounts.find((a) => a.id === visa.id), {
    month: JAN, asOf: '2026-01-28',
  });
  assert.equal(snap.balance, 42_000);
  assert.equal(snap.statementBalance, 30_000, 'only what closed on the 18th was billed');
});

test('a due date on the 31st clamps to the last day of a short month', () => {
  assert.equal(nextDayOfMonth(31, '2026-02-01'), '2026-02-28');
  assert.equal(nextDayOfMonth(31, '2024-02-01'), '2024-02-29', 'leap year');
  assert.equal(nextDayOfMonth(15, '2026-03-20'), '2026-04-15');
  assert.equal(nextDayOfMonth(20, '2026-03-20'), '2026-03-20', 'today counts');
});

test('payoff schedule amortises to zero and totals the interest', () => {
  const result = payoffSchedule(100_000, 0.24, 10_000);
  assert.ok(result.months > 10 && result.months < 14, `expected ~11 months, got ${result.months}`);
  assert.equal(result.neverPaysOff, false);
  assert.equal(result.schedule.at(-1).balance, 0);
  assert.ok(result.totalInterest > 0);
  assert.equal(result.totalPaid, 100_000 + result.totalInterest);

  // Every row's principal plus interest equals the payment made.
  for (const row of result.schedule) {
    assert.equal(row.principal + row.interest, row.payment);
  }
});

test('a payment below the monthly interest is reported as never paying off', () => {
  // 24% APR on $1,000 is $20/month of interest; paying $15 goes backwards.
  const result = payoffSchedule(100_000, 0.24, 1_500);
  assert.equal(result.neverPaysOff, true);
  assert.equal(result.months, 0);
  assert.equal(result.schedule.length, 0);
});

test('an interest-free balance pays off in exact instalments', () => {
  const result = payoffSchedule(100_000, 0, 25_000);
  assert.equal(result.months, 4);
  assert.equal(result.totalInterest, 0);
  assert.equal(result.totalPaid, 100_000);
});

test('zero balance needs no plan', () => {
  const result = payoffSchedule(0, 0.2, 5_000);
  assert.equal(result.months, 0);
  assert.equal(result.neverPaysOff, false);
});

test('paying more than the minimum saves months and interest', () => {
  const { visa } = withCard();
  const comparison = payoffComparison(visa, 300_000, 30_000);
  assert.ok(comparison.minimum > 0);
  assert.ok(comparison.monthsSaved > 0, 'faster');
  assert.ok(comparison.interestSaved > 0, 'cheaper');
});

test('upcoming payments only lists cards that owe something', () => {
  let { state, visa, groceries } = withCard();
  assert.equal(upcomingPayments(state, { asOf: '2026-01-20' }).length, 0);

  state = actions.addTransaction(state, {
    date: '2026-01-05', accountId: visa.id, categoryId: groceries.id, amount: -50_000, kind: 'expense',
  });
  const due = upcomingPayments(state, { days: 40, asOf: '2026-01-20' });
  assert.equal(due.length, 1);
  assert.equal(due[0].card.id, visa.id);
});

test('portfolio totals add up across cards', () => {
  let { state, groceries } = withCard();
  state = actions.addAccount(state, {
    name: 'Second Card', type: 'credit', openingBalance: -50_000, openedOn: `${JAN}-01`,
    creditLimit: 100_000, apr: 0.3,
  });
  const visa = state.accounts.find((a) => a.name === 'Visa');
  state = actions.addTransaction(state, {
    date: `${JAN}-05`, accountId: visa.id, categoryId: groceries.id, amount: -100_000, kind: 'expense',
  });

  const summary = debtSummary(state, { month: JAN });
  assert.equal(summary.cards.length, 2);
  assert.equal(summary.balance, 150_000);
  assert.equal(summary.limit, 500_000);
  assert.equal(summary.reserved, 100_000, 'the new charge is reserved');
  assert.equal(summary.uncovered, 50_000, 'the inherited debt is not');
  assert.equal(summary.utilization, 0.3);
});

test('the sample data is internally consistent', () => {
  const state = seedState({ now: new Date('2026-07-25T12:00:00Z') });
  assert.ok(state.accounts.length >= 5);
  assert.ok(state.transactions.length > 50);

  // Every credit account has exactly one payment envelope.
  for (const account of state.accounts.filter((a) => a.type === 'credit')) {
    const envelopes = state.categories.filter(
      (c) => c.kind === 'ccPayment' && c.accountId === account.id,
    );
    assert.equal(envelopes.length, 1, `${account.name} should own one payment envelope`);
  }

  // Transfers are always paired.
  const byTransfer = new Map();
  for (const tx of state.transactions.filter((t) => t.transferId)) {
    byTransfer.set(tx.transferId, (byTransfer.get(tx.transferId) || 0) + tx.amount);
  }
  for (const [id, net] of byTransfer) {
    assert.equal(net, 0, `transfer ${id} should net to zero`);
  }

  // And the whole budget reconciles for every month it covers.
  for (const month of monthRange(addMonths('2026-07', -3), '2026-07')) {
    const check = reconcile(state, month);
    assert.equal(check.balanced, true, `${month} should reconcile (out by ${check.difference})`);
  }
});

test('money parsing and formatting survive user input', () => {
  assert.equal(parseMoney('1,234.56'), 123_456);
  assert.equal(parseMoney('$12'), 1_200);
  assert.equal(parseMoney('-4.5'), -450);
  assert.equal(parseMoney(''), 0);
  assert.equal(parseMoney('abc'), 0);
  assert.equal(parseMoney(12.34), 1_234);

  const opts = { currency: 'USD', locale: 'en-US' };
  assert.equal(formatMoney(123_456, opts), '$1,234.56');
  assert.equal(formatMoney(-500, opts), '-$5.00');
  assert.equal(formatMoney(500, { ...opts, signed: true }), '+$5.00');
  assert.equal(formatMoney(123_456, { ...opts, cents: false }), '$1,235');
  assert.equal(formatMoneyCompact(450_000, opts), '$4.5K');
});
