/**
 * Recurring bills.
 *
 * Two claims are worth pinning down, because everything else in the feature
 * rests on them:
 *
 *   · **The schedule is derived.** One anchor date and a cadence produce every
 *     occurrence, including across month lengths that do not agree, and nothing
 *     is rolled over at the end of a month.
 *   · **"Paid" lives in the ledger.** An occurrence is settled by a transaction
 *     carrying the bill's id and that due date — so deleting the payment un-pays
 *     the month, and tracking a bill moves no money at all.
 *
 * Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emptyState, makeBill } from '../src/core/model.ts';
import type { AppState, Bill } from '../src/core/model.ts';
import * as actions from '../src/core/actions.ts';
import {
  billFunding, billNameTaken, billSnapshot, billTotals, forecastAmount, linkableTransactions,
  occurrencesBetween, occurrencesInMonth, suggestedBills, upcomingBills,
} from '../src/core/bills.ts';
import { accountBalance, cashOnHand, categoryRow, monthSummary, readyToAssign } from '../src/core/budget.ts';
import { dueReminders, plannedReminders } from '../src/core/reminders.ts';
import { account, category, creditAccount, must, paymentEnvelope } from './helpers.ts';

const MAY = '2026-05';

/** A chequing account, a card, two envelopes, and rent due on the 1st. */
function fixture() {
  let state: AppState = emptyState(new Date('2026-05-01T00:00:00Z'));
  state = actions.addAccount(state, {
    name: 'Checking', type: 'checking', openingBalance: 500_000, openedOn: `${MAY}-01`,
  });
  state = actions.addAccount(state, {
    name: 'Visa', type: 'credit', openingBalance: 0, openedOn: `${MAY}-01`,
    creditLimit: 500_000, apr: 0.2, statementDay: 18, dueDay: 12,
  });
  state = actions.addCategory(state, { name: 'Housing', group: 'Bills' });
  state = actions.addCategory(state, { name: 'Utilities', group: 'Bills' });

  const housing = category(state, 'Housing');
  state = actions.addBill(state, {
    name: 'Rent',
    payee: 'Harbourview Lettings',
    amount: 165_000,
    cadence: 'monthly',
    startDate: `${MAY}-01`,
    categoryId: housing.id,
    accountId: account(state, 'Checking').id,
  });

  return {
    state,
    checking: account(state, 'Checking'),
    visa: creditAccount(state, 'Visa'),
    housing,
    utilities: category(state, 'Utilities'),
  };
}

const rent = (state: AppState): Bill => must(state.bills[0], 'the rent bill');

/* ── The schedule falls out of one date ───────────────────────────────── */

test('a cadence and one anchor generate every due date', () => {
  const monthly = makeBill({ cadence: 'monthly', startDate: '2026-05-10' });
  assert.deepEqual(
    occurrencesBetween(monthly, '2026-05-01', '2026-08-31'),
    ['2026-05-10', '2026-06-10', '2026-07-10', '2026-08-10'],
  );

  const weekly = makeBill({ cadence: 'weekly', startDate: '2026-05-04' });
  assert.deepEqual(
    occurrencesBetween(weekly, '2026-05-01', '2026-05-31'),
    ['2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25'],
  );

  const quarterly = makeBill({ cadence: 'quarterly', startDate: '2026-02-15' });
  assert.deepEqual(
    occurrencesBetween(quarterly, '2026-01-01', '2026-12-31'),
    ['2026-02-15', '2026-05-15', '2026-08-15', '2026-11-15'],
  );

  const annual = makeBill({ cadence: 'annual', startDate: '2026-03-09' });
  assert.deepEqual(occurrencesBetween(annual, '2026-01-01', '2028-12-31'), [
    '2026-03-09', '2027-03-09', '2028-03-09',
  ]);
});

test('a due date past the end of a shorter month clamps to its last day', () => {
  const bill = makeBill({ cadence: 'monthly', startDate: '2026-01-31' });
  assert.deepEqual(
    occurrencesBetween(bill, '2026-01-01', '2026-05-31'),
    // February has 28 days in 2026 — and March goes back to the 31st rather
    // than staying stuck on the 28th.
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'],
  );
});

test('the schedule starts at its anchor and stops at its end date', () => {
  const bill = makeBill({ cadence: 'monthly', startDate: '2026-05-01', endDate: '2026-07-01' });
  // Nothing before the anchor: a bill entered with its next due date must not
  // invent a history of dates that were never billed.
  assert.deepEqual(occurrencesBetween(bill, '2025-01-01', '2026-04-30'), []);
  assert.deepEqual(occurrencesBetween(bill, '2026-01-01', '2027-01-01'), [
    '2026-05-01', '2026-06-01', '2026-07-01',
  ]);
});

test('a fortnightly bill lands twice in most months and three times in some', () => {
  const bill = makeBill({ cadence: 'fortnightly', startDate: '2026-05-01' });
  assert.deepEqual(occurrencesInMonth(bill, '2026-05'), ['2026-05-01', '2026-05-15', '2026-05-29']);
  assert.deepEqual(occurrencesInMonth(bill, '2026-06'), ['2026-06-12', '2026-06-26']);
});

/* ── Tracking a bill is not a transaction ─────────────────────────────── */

test('tracking a bill moves no money', () => {
  const { state } = fixture();
  assert.equal(state.transactions.length, 0);
  assert.equal(cashOnHand(state), 500_000);
  assert.equal(readyToAssign(state, MAY), 500_000);
});

test('a bill needs an anchor date, or it has no schedule to be', () => {
  const before = emptyState(new Date('2026-05-01T00:00:00Z'));
  const after = actions.addBill(before, { name: 'Rent', amount: 1000 });
  assert.equal(after, before, 'a bill with no due date is refused rather than stored empty');
});

test('a name already tracked is flagged, case and spacing aside, but not against itself', () => {
  const { state } = fixture();
  const rent = state.bills?.find((b) => b.name === 'Rent');
  assert.equal(billNameTaken(state, 'Rent'), true);
  assert.equal(billNameTaken(state, ' rent '), true, 'case and spacing are ignored');
  assert.equal(billNameTaken(state, 'Internet'), false);
  assert.equal(billNameTaken(state, 'Rent', { excludeId: rent?.id }), false, 'editing does not collide with itself');
});

/* ── "Paid" is read back out of the ledger ────────────────────────────── */

test('a payment tagged with the bill and due date settles that occurrence', () => {
  const { state, checking } = fixture();
  const bill = rent(state);

  const before = billSnapshot(state, bill, { asOf: `${MAY}-03`, month: MAY });
  assert.equal(before.status, 'overdue', 'the 1st has passed and nothing has been recorded');
  assert.equal(before.dueThisMonth, 165_000);

  const paid = actions.payBill(state, {
    billId: bill.id,
    dueDate: `${MAY}-01`,
    date: `${MAY}-03`,
    accountId: checking.id,
  });

  const after = billSnapshot(paid, rent(paid), { asOf: `${MAY}-03`, month: MAY });
  assert.equal(after.status, 'upcoming', 'the next occurrence is June');
  assert.equal(must(after.next, 'the next occurrence').dueDate, '2026-06-01');
  assert.equal(after.dueThisMonth, 0);
  assert.equal(after.paidThisMonth, 165_000);
  assert.equal(accountBalance(paid, checking.id), 500_000 - 165_000);
});

test('deleting the payment un-pays the month', () => {
  const { state, checking } = fixture();
  const bill = rent(state);
  const paid = actions.payBill(state, { billId: bill.id, dueDate: `${MAY}-01`, accountId: checking.id });
  const payment = must(paid.transactions[0], 'the rent payment');

  const undone = actions.deleteTransaction(paid, payment.id);
  const snapshot = billSnapshot(undone, rent(undone), { asOf: `${MAY}-03`, month: MAY });
  assert.equal(snapshot.status, 'overdue');
  assert.equal(snapshot.paidThisMonth, 0);
});

test('the payment is ordinary categorised spending, and reports what was really paid', () => {
  const { state, checking, housing } = fixture();
  const bill = rent(state);
  // The landlord put the rent up; the bill still says 165,000.
  const paid = actions.payBill(state, {
    billId: bill.id, dueDate: `${MAY}-01`, date: `${MAY}-02`, accountId: checking.id, amount: 172_000,
  });

  const tx = must(paid.transactions[0], 'the payment');
  assert.equal(tx.kind, 'expense');
  assert.equal(tx.amount, -172_000);
  assert.equal(tx.categoryId, housing.id);
  assert.equal(tx.payee, 'Harbourview Lettings');
  assert.equal(categoryRow(monthSummary(paid, MAY), housing.id).activity, -172_000);

  const occurrence = must(
    billSnapshot(paid, rent(paid), { asOf: `${MAY}-03`, month: MAY }).thisMonth[0],
    'the May occurrence',
  );
  assert.equal(occurrence.amount, 172_000, 'the occurrence reports the payment, not the estimate');
});

test('a bill paid on a card reserves the cash in that card’s payment envelope', () => {
  const { state, visa } = fixture();
  const bill = rent(state);
  const paid = actions.payBill(state, {
    billId: bill.id, dueDate: `${MAY}-01`, date: `${MAY}-01`, accountId: visa.id,
  });

  const envelope = paymentEnvelope(paid, visa.id);
  const row = categoryRow(monthSummary(paid, MAY), envelope.id);
  assert.equal(row.reserved, 165_000, 'card spending funds the payment envelope, bills included');
  assert.equal(accountBalance(paid, visa.id), -165_000);
});

/* ── Pointing an existing transaction at an occurrence ───────────────────── */

test('an existing transaction can settle an occurrence instead of a new payment', () => {
  const { state, checking, housing } = fixture();
  const bill = rent(state);
  // Typed in by hand before the bill was ever tracked — no billId, no receipt.
  let next = actions.addTransaction(state, {
    date: `${MAY}-01`, accountId: checking.id, categoryId: housing.id,
    payee: 'Harbourview Lettings', amount: -165_000, kind: 'expense',
  });
  const tx = must(next.transactions[0], 'the hand-typed transaction');

  next = actions.linkBillPayment(next, { billId: bill.id, dueDate: `${MAY}-01`, transactionId: tx.id });

  assert.equal(next.transactions.length, 1, 'nothing new was written');
  assert.equal(must(next.transactions[0], 'the transaction').billId, bill.id);
  assert.equal(must(next.transactions[0], 'the transaction').billDue, `${MAY}-01`);

  const occurrence = must(
    billSnapshot(next, rent(next), { asOf: `${MAY}-03`, month: MAY }).thisMonth[0],
    'the May occurrence',
  );
  assert.equal(occurrence.status, 'paid');
  assert.equal(occurrence.paid?.id, tx.id);
});

test('linking settles the argument about a skipped occurrence, the same as paying it', () => {
  const { state, checking } = fixture();
  const bill = rent(state);
  let next = actions.skipBillOccurrence(state, bill.id, `${MAY}-01`);
  next = actions.addTransaction(next, {
    date: `${MAY}-01`, accountId: checking.id, payee: 'Harbourview Lettings', amount: -165_000, kind: 'expense',
  });
  const tx = must(next.transactions[0], 'the transaction');

  next = actions.linkBillPayment(next, { billId: bill.id, dueDate: `${MAY}-01`, transactionId: tx.id });

  assert.deepEqual(rent(next).skipped, []);
  assert.equal(must(billSnapshot(next, rent(next), { asOf: `${MAY}-03`, month: MAY }).thisMonth[0], 'May').status, 'paid');
});

test('unlinking un-pays the occurrence without touching the money', () => {
  const { state, checking } = fixture();
  const bill = rent(state);
  const paid = actions.payBill(state, { billId: bill.id, dueDate: `${MAY}-01`, accountId: checking.id });
  const tx = must(paid.transactions[0], 'the payment');

  const unlinked = actions.unlinkBillPayment(paid, tx.id);

  assert.equal(unlinked.transactions.length, paid.transactions.length, 'the transaction still exists');
  const same = must(unlinked.transactions.find((t) => t.id === tx.id), 'the same transaction');
  assert.equal(same.billId, null);
  assert.equal(same.billDue, null);
  assert.equal(same.amount, tx.amount, 'the money moved is untouched');
  assert.equal(
    billSnapshot(unlinked, rent(unlinked), { asOf: `${MAY}-03`, month: MAY }).thisMonth[0]?.status,
    'overdue',
    'the occurrence reads unpaid again',
  );
});

test('a transaction already linked elsewhere is not offered a second time', () => {
  const { state, checking, housing } = fixture();
  const bill = rent(state);
  let next = actions.addTransaction(state, {
    date: `${MAY}-01`, accountId: checking.id, categoryId: housing.id,
    payee: 'Harbourview Lettings', amount: -165_000, kind: 'expense',
  });
  const unlinked = must(next.transactions[0], 'the candidate');
  assert.ok(
    linkableTransactions(next, bill, `${MAY}-01`).some((tx) => tx.id === unlinked.id),
    'an unlinked transaction is offered',
  );

  next = actions.linkBillPayment(next, { billId: bill.id, dueDate: `${MAY}-01`, transactionId: unlinked.id });
  assert.ok(
    !linkableTransactions(next, bill, `${MAY}-01`).some((tx) => tx.id === unlinked.id),
    'a linked transaction is not offered again',
  );
});

test('candidates on the bill’s usual account are offered before ones on another', () => {
  const { state, checking, visa, housing } = fixture();
  const bill = rent(state); // accountId is Checking
  let next = actions.addTransaction(state, {
    date: `${MAY}-01`, accountId: visa.id, categoryId: housing.id,
    payee: 'Harbourview Lettings', amount: -165_000, kind: 'expense',
  });
  next = actions.addTransaction(next, {
    date: `${MAY}-10`, accountId: checking.id, categoryId: housing.id,
    payee: 'Harbourview Lettings', amount: -165_000, kind: 'expense',
  });

  const candidates = linkableTransactions(next, bill, `${MAY}-01`);
  // The Visa transaction sits closer to the due date, but Checking is the
  // account this bill is normally paid from.
  assert.equal(candidates[0]?.accountId, checking.id);
});

/* ── Skipping ─────────────────────────────────────────────────────────── */

test('a skipped occurrence stops being due without touching the rest', () => {
  const { state } = fixture();
  const bill = rent(state);
  const skipped = actions.skipBillOccurrence(state, bill.id, `${MAY}-01`);

  const snapshot = billSnapshot(skipped, rent(skipped), { asOf: `${MAY}-03`, month: MAY });
  assert.equal(snapshot.dueThisMonth, 0);
  assert.equal(must(snapshot.next, 'the next occurrence').dueDate, '2026-06-01');
  assert.equal(must(snapshot.thisMonth[0], 'the May occurrence').status, 'skipped');

  const restored = actions.unskipBillOccurrence(skipped, bill.id, `${MAY}-01`);
  assert.equal(billSnapshot(restored, rent(restored), { asOf: `${MAY}-03`, month: MAY }).dueThisMonth, 165_000);
});

test('paying an occurrence that was marked skipped settles the argument', () => {
  const { state, checking } = fixture();
  const bill = rent(state);
  let next = actions.skipBillOccurrence(state, bill.id, `${MAY}-01`);
  next = actions.payBill(next, { billId: bill.id, dueDate: `${MAY}-01`, accountId: checking.id });

  assert.deepEqual(rent(next).skipped, []);
  assert.equal(must(billSnapshot(next, rent(next), { asOf: `${MAY}-03`, month: MAY }).thisMonth[0], 'May').status, 'paid');
});

/* ── Variable bills forecast themselves ───────────────────────────────── */

test('a variable bill is forecast from what it has actually cost', () => {
  const { state, checking, utilities } = fixture();
  let next = actions.addBill(state, {
    name: 'Electricity',
    amount: 10_000,
    variable: true,
    cadence: 'monthly',
    startDate: '2026-02-08',
    categoryId: utilities.id,
    accountId: checking.id,
  });
  const power = must(next.bills[1], 'the electricity bill');
  assert.equal(forecastAmount(next, power), 10_000, 'the stated amount, until there is history');

  for (const [dueDate, amount] of [['2026-02-08', 9_000], ['2026-03-08', 12_000], ['2026-04-08', 15_000]] as const) {
    next = actions.payBill(next, { billId: power.id, dueDate, date: dueDate, accountId: checking.id, amount });
  }
  assert.equal(forecastAmount(next, power), 12_000, 'the average of the last three');

  const snapshot = billSnapshot(next, must(next.bills[1], 'the electricity bill'), {
    asOf: '2026-05-01', month: MAY,
  });
  assert.equal(snapshot.expected, 12_000);
  assert.equal(snapshot.dueThisMonth, 12_000, 'May is forecast, not quoted');
});

/* ── What a month costs ───────────────────────────────────────────────── */

test('every cadence reduces to a monthly figure', () => {
  const { state, utilities, checking } = fixture();
  let next = actions.addBill(state, {
    name: 'Home insurance', amount: 30_000, cadence: 'annual', startDate: '2026-05-20',
    categoryId: utilities.id, accountId: checking.id,
  });
  next = actions.addBill(next, {
    name: 'Water', amount: 6_000, cadence: 'quarterly', startDate: '2026-05-12',
    categoryId: utilities.id, accountId: checking.id,
  });

  const totals = billTotals(next, { asOf: `${MAY}-01`, month: MAY });
  // 165,000 monthly + 30,000/12 + 6,000/4.
  assert.equal(totals.monthlyCommitment, 165_000 + 2_500 + 2_000);
  // …but what May actually bills is all three in full, because all three land.
  assert.equal(totals.dueThisMonth, 165_000 + 30_000 + 6_000);
});

test('bills due within the window are listed, and settled ones drop out', () => {
  const { state, checking } = fixture();
  const bill = rent(state);
  assert.equal(upcomingBills(state, { asOf: `${MAY}-01`, days: 30, month: MAY }).length, 1);

  const paid = actions.payBill(state, { billId: bill.id, dueDate: `${MAY}-01`, accountId: checking.id });
  const stillDue = upcomingBills(paid, { asOf: `${MAY}-01`, days: 15, month: MAY });
  assert.deepEqual(stillDue, [], 'June is beyond the window, and May is settled');
});

/* ── Funding: a date with no money behind it ──────────────────────────── */

test('an envelope short of its bills is reported, and topping it up clears the gap', () => {
  const { state, housing } = fixture();

  const short = billFunding(state, { asOf: `${MAY}-01`, month: MAY });
  assert.equal(short.due, 165_000);
  assert.equal(short.uncovered, 165_000, 'nothing has been assigned yet');
  assert.equal(short.unfundedCount, 1);

  const funded = actions.setBudget(state, MAY, housing.id, 165_000);
  const after = billFunding(funded, { asOf: `${MAY}-01`, month: MAY });
  assert.equal(after.uncovered, 0);
  assert.equal(must(after.rows[0], 'the housing row').available, 165_000);
});

test('funding this month’s bills never assigns money that is not there', () => {
  const { state, housing, utilities, checking } = fixture();
  // A second bill, and only enough cash for part of the pair.
  let next = actions.addBill(state, {
    name: 'Electricity', amount: 20_000, cadence: 'monthly', startDate: `${MAY}-08`,
    categoryId: utilities.id, accountId: checking.id,
  });
  // Spend the account down so Ready to assign cannot cover both bills.
  next = actions.addTransaction(next, {
    date: `${MAY}-01`, accountId: checking.id, categoryId: null, amount: -330_000, kind: 'expense',
    payee: 'Car repair',
  });
  assert.equal(readyToAssign(next, MAY), 170_000);

  const assigned = actions.assignForBills(next, MAY);
  assert.equal(readyToAssign(assigned, MAY), 0, 'it stops at zero rather than over-assigning');
  // Rent is due first, so it is funded first and in full.
  assert.equal(assigned.budgets[MAY]?.[housing.id], 165_000);
  assert.equal(assigned.budgets[MAY]?.[utilities.id], 5_000);

  const remaining = billFunding(assigned, { asOf: `${MAY}-01`, month: MAY });
  assert.equal(remaining.uncovered, 15_000, 'what is still short stays visible');
});

test('an already funded month has nothing to assign', () => {
  const { state, housing } = fixture();
  const funded = actions.setBudget(state, MAY, housing.id, 165_000);
  assert.equal(actions.assignForBills(funded, MAY), funded);
});

/* ── Reminders ────────────────────────────────────────────────────────── */

function withReminders(state: AppState): AppState {
  return {
    ...state,
    settings: { ...state.settings, reminders: { ...state.settings.reminders, enabled: true, leadDays: 3 } },
  };
}

test('a bill coming due is worth a reminder, and paying it silences one', () => {
  const { state, checking } = fixture();
  const on = withReminders(state);

  const planned = plannedReminders(on, { asOf: '2026-04-25' });
  const kinds = planned.filter((r) => r.subjectId === rent(on).id).map((r) => r.kind);
  assert.deepEqual(kinds, ['bill-due-soon', 'bill-due-today']);

  // Three days out, the lead reminder is what is due to be shown.
  const due = dueReminders(on, { asOf: '2026-04-28' });
  assert.equal(must(due[0], 'the lead reminder').kind, 'bill-due-soon');

  const paid = actions.payBill(on, { billId: rent(on).id, dueDate: `${MAY}-01`, accountId: checking.id });
  assert.deepEqual(
    dueReminders(paid, { asOf: '2026-04-28' }),
    [],
    'a bill already paid has nothing to say',
  );
});

test('a bill past its date repeats, urgently', () => {
  const { state } = fixture();
  const overdue = plannedReminders(withReminders(state), { asOf: `${MAY}-04` })
    .filter((r) => r.kind === 'bill-overdue');
  assert.ok(overdue.length > 1, 'being late is a state, so it is said more than once');
  assert.ok(overdue.every((r) => r.urgent));
});

test('an automatic bill is announced but does not interrupt', () => {
  const { state } = fixture();
  const auto = actions.updateBill(state, rent(state).id, { autopay: true });
  const today = plannedReminders(withReminders(auto), { asOf: `${MAY}-01` })
    .filter((r) => r.kind === 'bill-due-today');
  assert.equal(must(today[0], 'the due-today reminder').urgent, false);
  assert.match(must(today[0], 'the due-today reminder').body, /leaves automatically/);
});

test('bill reminders can be switched off on their own', () => {
  const { state } = fixture();
  const on = withReminders(state);
  const off: AppState = {
    ...on,
    settings: { ...on.settings, reminders: { ...on.settings.reminders, bills: false } },
  };
  assert.deepEqual(plannedReminders(off, { asOf: '2026-04-28' }), []);
});

/* ── Deleting things it points at ─────────────────────────────────────── */

test('untracking a bill keeps the spending and drops the receipts', () => {
  const { state, checking, housing } = fixture();
  const bill = rent(state);
  const paid = actions.payBill(state, { billId: bill.id, dueDate: `${MAY}-01`, accountId: checking.id });

  const removed = actions.deleteBill(paid, bill.id);
  assert.deepEqual(removed.bills, []);
  assert.equal(removed.transactions.length, 1, 'the payment is real spending and stays');
  const tx = must(removed.transactions[0], 'the payment');
  assert.equal(tx.billId, null, 'but it no longer points at a bill that is gone');
  assert.equal(tx.categoryId, housing.id, 'and it is still budgeted where it was');
  assert.equal(accountBalance(removed, checking.id), 500_000 - 165_000);
});

test('a bill outlives the account and category it referenced', () => {
  const { state, checking, housing } = fixture();
  const withoutAccount = actions.deleteAccount(state, checking.id);
  assert.equal(rent(withoutAccount).accountId, null);
  assert.equal(rent(withoutAccount).name, 'Rent', 'the commitment is still real');

  const withoutCategory = actions.deleteCategory(state, housing.id);
  assert.equal(rent(withoutCategory).categoryId, null);
  // With no envelope there is nothing holding the money, so none of it is covered.
  const funding = billFunding(withoutCategory, { asOf: `${MAY}-01`, month: MAY });
  assert.equal(funding.uncovered, 165_000);
});

/* ── Backups ──────────────────────────────────────────────────────────── */

test('bills survive a backup round trip', () => {
  const { state, checking } = fixture();
  const paid = actions.payBill(state, { billId: rent(state).id, dueDate: `${MAY}-01`, accountId: checking.id });
  const restored = actions.fromBackup(actions.toBackup(paid));

  assert.equal(restored.bills.length, 1);
  const snapshot = billSnapshot(restored, rent(restored), { asOf: `${MAY}-03`, month: MAY });
  assert.equal(snapshot.paidThisMonth, 165_000, 'the receipt on the transaction came across too');
});

test('a backup written before bills existed still loads', () => {
  const legacy = actions.toBackup(emptyState(new Date('2026-05-01T00:00:00Z')));
  const parsed = JSON.parse(legacy) as Record<string, unknown>;
  delete parsed.bills;

  const restored = actions.fromBackup(JSON.stringify(parsed));
  assert.deepEqual(restored.bills, []);
  assert.deepEqual(billTotals(restored, { month: MAY }).bills, []);
});

/* ── Recognising one ──────────────────────────────────────────────────── */

test('a payee paid on a rhythm is offered as a bill', () => {
  const { state, checking, utilities } = fixture();
  let next = state;
  for (const [date, amount] of [['2026-02-06', 7_900], ['2026-03-06', 7_900], ['2026-04-06', 7_900]] as const) {
    next = actions.addTransaction(next, {
      date, accountId: checking.id, categoryId: utilities.id, amount: -amount, kind: 'expense', payee: 'Fibrenet',
    });
  }

  const suggestion = must(suggestedBills(next)[0], 'the Fibrenet suggestion');
  assert.equal(suggestion.name, 'Fibrenet');
  assert.equal(suggestion.cadence, 'monthly');
  assert.equal(suggestion.amount, 7_900);
  assert.equal(suggestion.variable, false, 'three identical amounts are not a variable bill');
  assert.equal(suggestion.startDate, '2026-04-06', 'anchored to the most recent one');
  assert.equal(suggestion.categoryId, utilities.id);

  // Once it is tracked it stops being suggested.
  const tracked = actions.addBill(next, suggestion);
  assert.deepEqual(suggestedBills(tracked).map((draft) => draft.name), []);
});

test('a shop you happen to like is not a bill', () => {
  const { state, checking, utilities } = fixture();
  let next = state;
  // The same payee, often, on no rhythm at all — the shape of ordinary
  // spending, and the false positive worth being strict about.
  for (const [date, amount] of [
    ['2026-02-03', 2_100], ['2026-02-17', 4_400], ['2026-03-02', 1_200],
    ['2026-03-19', 3_900], ['2026-04-11', 2_650],
  ] as const) {
    next = actions.addTransaction(next, {
      date, accountId: checking.id, categoryId: utilities.id, amount: -amount, kind: 'expense', payee: 'Corner Deli',
    });
  }
  assert.deepEqual(suggestedBills(next).map((draft) => draft.name), []);
});
