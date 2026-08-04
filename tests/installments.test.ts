/**
 * Instalment plans.
 *
 * Progress is **derived** from the calendar rather than stored, so most of what
 * is checked here is that a plan reads correctly at different points in its
 * life — before it starts, midway, on its last month, and long after it
 * finished — without anything having been advanced by hand.
 *
 * The other thing pinned here is that a plan creates no transactions. Each
 * month's instalment already reaches the ledger as an ordinary charge, and a
 * plan that generated them too would bill every purchase twice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as actions from '../src/core/actions.ts';
import { emptyState } from '../src/core/model.ts';
import type { AppState } from '../src/core/model.ts';
import {
  cardInstallments, findMatchingPlan, installmentSnapshot, installmentSummary,
  parseInstallmentMarker, planFromStatementRow,
} from '../src/core/installments.ts';
import { accountBalance } from '../src/core/budget.ts';
import { account, must } from './helpers.ts';

/** One card, and a ₱24,000 appliance over twelve months from April 2026. */
function stateWithPlan(): AppState {
  let state = emptyState(new Date(2026, 3, 1));
  state = actions.addAccount(state, {
    name: 'BDO Gold', type: 'credit', provider: 'BDO', creditLimit: 200_000_00, openedOn: '2026-04-01',
  });
  state = actions.addInstallment(state, {
    accountId: account(state, 'BDO Gold').id,
    description: 'Appliance — SM Megamall',
    monthlyAmount: 2_000_00,
    months: 12,
    startMonth: '2026-04',
    principal: 24_000_00,
  });
  return state;
}

const plan = (state: AppState) => must(state.installments[0], 'the plan');

/* ── Progress falls out of the calendar ───────────────────────────────── */

test('a plan reads correctly at each point in its life', () => {
  const state = stateWithPlan();
  const at = (month: string) => installmentSnapshot(plan(state), month);

  // Before it starts.
  assert.equal(at('2026-03').billed, 0);
  assert.equal(at('2026-03').remainingAmount, 24_000_00);
  assert.equal(at('2026-03').activeThisMonth, false);

  // Its first month.
  assert.equal(at('2026-04').billed, 1);
  assert.equal(at('2026-04').remainingMonths, 11);
  assert.equal(at('2026-04').activeThisMonth, true);

  // Midway — the third of twelve.
  assert.equal(at('2026-06').billed, 3);
  assert.equal(at('2026-06').remainingAmount, 18_000_00);
  assert.equal(at('2026-06').progress, 0.25);

  // Its last month.
  assert.equal(at('2027-03').billed, 12);
  assert.equal(at('2027-03').remainingMonths, 0);
  assert.equal(at('2027-03').finished, true);
  assert.equal(at('2027-03').lastMonth, '2027-03');

  // Long afterwards: still finished, never over-counted.
  assert.equal(at('2030-01').billed, 12);
  assert.equal(at('2030-01').remainingAmount, 0);
  assert.equal(at('2030-01').activeThisMonth, false);
});

test('a plan that bills more than the price is not 0%', () => {
  const state = stateWithPlan();
  // 12 × 2,000 = 24,000, exactly the price.
  assert.equal(installmentSnapshot(plan(state), '2026-06').interestCost, 0);

  const dearer = actions.updateInstallment(state, plan(state).id, { monthlyAmount: 2_200_00 });
  assert.equal(installmentSnapshot(plan(dearer), '2026-06').interestCost, 2_400_00);

  const unknown = actions.updateInstallment(state, plan(state).id, { principal: null });
  assert.equal(installmentSnapshot(plan(unknown), '2026-06').interestCost, null);
});

/* ── Splitting a billing into principal and interest ────────────────────── */

test('absent a split, the whole billing is assumed to be principal', () => {
  const state = stateWithPlan();
  const snap = installmentSnapshot(plan(state), '2026-06');
  assert.equal(snap.monthlyPrincipal, 2_000_00);
  assert.equal(snap.monthlyInterest, 0);
  assert.equal(snap.billedPrincipal, snap.billedAmount);
  assert.equal(snap.remainingInterest, 0);
});

test('an explicit split reports principal and interest paid, and left to pay', () => {
  let state = stateWithPlan();
  state = actions.updateInstallment(state, plan(state).id, {
    monthlyAmount: 2_000_00, monthlyPrincipal: 1_850_00, monthlyInterest: 150_00,
  });

  // Midway: the third of twelve, billed in June.
  const snap = installmentSnapshot(plan(state), '2026-06');
  assert.equal(snap.billed, 3);
  assert.equal(snap.billedPrincipal, 3 * 1_850_00);
  assert.equal(snap.billedInterest, 3 * 150_00);
  assert.equal(snap.remainingPrincipal, 9 * 1_850_00);
  assert.equal(snap.remainingInterest, 9 * 150_00);
  // The issuer's own figure, exact — not inferred from a purchase price.
  assert.equal(snap.interestCost, 12 * 150_00);
});

test('giving only the interest portion derives the principal from what is left', () => {
  let state = stateWithPlan();
  state = actions.updateInstallment(state, plan(state).id, { monthlyInterest: 150_00, monthlyPrincipal: null });
  const snap = installmentSnapshot(plan(state), '2026-06');
  assert.equal(snap.monthlyInterest, 150_00);
  assert.equal(snap.monthlyPrincipal, 2_000_00 - 150_00);
});

test('a split survives a backup round trip', () => {
  let state = stateWithPlan();
  state = actions.updateInstallment(state, plan(state).id, { monthlyPrincipal: 1_850_00, monthlyInterest: 150_00 });
  const restored = actions.fromBackup(actions.toBackup(state));
  assert.equal(plan(restored).monthlyPrincipal, 1_850_00);
  assert.equal(plan(restored).monthlyInterest, 150_00);
});

/* ── Totals ───────────────────────────────────────────────────────────── */

test('the monthly figure counts only the plans billing that month', () => {
  let state = stateWithPlan();
  const cardId = account(state, 'BDO Gold').id;
  // A second, shorter plan that starts later and finishes sooner.
  state = actions.addInstallment(state, {
    accountId: cardId,
    description: 'Phone',
    monthlyAmount: 1_500_00,
    months: 3,
    startMonth: '2026-06',
    principal: null,
  });

  assert.equal(installmentSummary(state, { cardId, month: '2026-05' }).monthly, 2_000_00);
  assert.equal(installmentSummary(state, { cardId, month: '2026-06' }).monthly, 3_500_00);
  assert.equal(installmentSummary(state, { cardId, month: '2026-06' }).activeCount, 2);
  // The phone finishes in August, so September is the appliance alone.
  assert.equal(installmentSummary(state, { cardId, month: '2026-09' }).monthly, 2_000_00);
  // And after everything has run out.
  assert.equal(installmentSummary(state, { cardId, month: '2028-01' }).monthly, 0);
  assert.equal(installmentSummary(state, { cardId, month: '2028-01' }).remaining, 0);

  // Remaining looks forward from the month asked about.
  assert.equal(
    installmentSummary(state, { cardId, month: '2026-06' }).remaining,
    18_000_00 + 3_000_00,
  );
});

test('plans are listed soonest to finish first', () => {
  let state = stateWithPlan();
  const cardId = account(state, 'BDO Gold').id;
  state = actions.addInstallment(state, {
    accountId: cardId, description: 'Phone', monthlyAmount: 1_500_00, months: 3,
    startMonth: '2026-06', principal: null,
  });
  assert.deepEqual(
    cardInstallments(state, cardId, '2026-06').map((s) => s.plan.description),
    ['Phone', 'Appliance — SM Megamall'],
  );
});

/* ── A plan is not a transaction ──────────────────────────────────────── */

test('tracking a plan does not touch the ledger', () => {
  const state = stateWithPlan();
  const cardId = account(state, 'BDO Gold').id;
  assert.equal(state.transactions.length, 0, 'no transactions were generated');
  assert.equal(accountBalance(state, cardId), 0, 'and the card owes nothing yet');
});

test('a plan needs a card, a term and an amount', () => {
  const state = stateWithPlan();
  const cardId = account(state, 'BDO Gold').id;
  const before = state.installments.length;

  // Not a credit card.
  const withChecking = actions.addAccount(state, { name: 'Chequing', type: 'checking' });
  assert.equal(
    actions.addInstallment(withChecking, {
      accountId: account(withChecking, 'Chequing').id,
      monthlyAmount: 100_00, months: 6, startMonth: '2026-06',
    }).installments.length,
    before,
  );
  // No term, no amount, no start.
  assert.equal(actions.addInstallment(state, { accountId: cardId, monthlyAmount: 100_00, months: 0, startMonth: '2026-06' }).installments.length, before);
  assert.equal(actions.addInstallment(state, { accountId: cardId, monthlyAmount: 0, months: 6, startMonth: '2026-06' }).installments.length, before);
  assert.equal(actions.addInstallment(state, { accountId: cardId, monthlyAmount: 100_00, months: 6, startMonth: '' }).installments.length, before);
});

/* ── Converting an existing transaction ───────────────────────────────── */

test('converting a transaction to instalments rewrites it down to the monthly figure', () => {
  let state = emptyState(new Date(2026, 3, 1));
  state = actions.addAccount(state, {
    name: 'BDO Gold', type: 'credit', provider: 'BDO', creditLimit: 200_000_00, openedOn: '2026-04-01',
  });
  const cardId = account(state, 'BDO Gold').id;
  state = actions.addTransaction(state, {
    date: '2026-04-10', accountId: cardId, payee: 'Appliance — SM Megamall', amount: -24_000_00, kind: 'expense',
  });
  const txId = state.transactions[0].id;

  const next = actions.convertTransactionToInstallment(state, { transactionId: txId, months: 12 });

  // The plan carries the price and the term …
  assert.equal(next.installments.length, 1);
  const plan = next.installments[0];
  assert.equal(plan.principal, 24_000_00);
  assert.equal(plan.monthlyAmount, 2_000_00);
  assert.equal(plan.months, 12);
  assert.equal(plan.startMonth, '2026-04');
  assert.equal(plan.description, 'Appliance — SM Megamall');

  // … and the transaction becomes the first instalment rather than a second charge.
  const tx = must(next.transactions.find((t) => t.id === txId), 'the transaction');
  assert.equal(tx.amount, -2_000_00);
  assert.equal(next.transactions.length, 1, 'no second transaction was created');
});

test('a chosen monthly figure and description override the defaults', () => {
  let state = emptyState(new Date(2026, 3, 1));
  state = actions.addAccount(state, {
    name: 'BDO Gold', type: 'credit', provider: 'BDO', creditLimit: 200_000_00, openedOn: '2026-04-01',
  });
  const cardId = account(state, 'BDO Gold').id;
  state = actions.addTransaction(state, {
    date: '2026-04-10', accountId: cardId, payee: 'Sofa', amount: -10_000_00, kind: 'expense',
  });
  const txId = state.transactions[0].id;

  const next = actions.convertTransactionToInstallment(state, {
    transactionId: txId, months: 3, monthlyAmount: 3_500_00, description: 'Sofa — 0% promo', startMonth: '2026-05',
  });
  const plan = next.installments[0];
  assert.equal(plan.monthlyAmount, 3_500_00, 'the issuer’s own figure wins over an even split');
  assert.equal(plan.description, 'Sofa — 0% promo');
  assert.equal(plan.startMonth, '2026-05');
  assert.equal(plan.principal, 10_000_00, 'the price is what was actually charged, not the new monthly total');

  const tx = must(next.transactions.find((t) => t.id === txId), 'the transaction');
  assert.equal(tx.amount, -3_500_00);
});

test('conversion is refused off a credit card, for non-expenses, and for too short a term', () => {
  let state = emptyState(new Date(2026, 3, 1));
  state = actions.addAccount(state, { name: 'Chequing', type: 'checking' });
  state = actions.addAccount(state, {
    name: 'BDO Gold', type: 'credit', provider: 'BDO', creditLimit: 200_000_00, openedOn: '2026-04-01',
  });
  const cardId = account(state, 'BDO Gold').id;
  const checkingId = account(state, 'Chequing').id;

  state = actions.addTransaction(state, {
    date: '2026-04-10', accountId: checkingId, payee: 'Groceries', amount: -3_000_00, kind: 'expense',
  });
  const notOnACard = state.transactions[0].id;
  assert.equal(
    actions.convertTransactionToInstallment(state, { transactionId: notOnACard, months: 6 }).installments.length,
    0,
    'not on a credit card',
  );

  state = actions.addTransaction(state, {
    date: '2026-04-10', accountId: cardId, payee: 'Salary bonus', amount: 5_000_00, kind: 'income',
  });
  const income = state.transactions[1].id;
  assert.equal(
    actions.convertTransactionToInstallment(state, { transactionId: income, months: 6 }).installments.length,
    0,
    'income is not a purchase',
  );

  state = actions.addTransaction(state, {
    date: '2026-04-10', accountId: cardId, payee: 'Coffee', amount: -150_00, kind: 'expense',
  });
  const oneMonth = state.transactions[2].id;
  assert.equal(
    actions.convertTransactionToInstallment(state, { transactionId: oneMonth, months: 1 }).installments.length,
    0,
    'a single instalment is not a plan',
  );

  const before = state.transactions.length;
  assert.equal(
    actions.convertTransactionToInstallment(state, { transactionId: 'missing', months: 6 }).transactions.length,
    before,
    'an unknown transaction changes nothing',
  );
});

/* ── Tagging a transaction as one of a plan's billings ──────────────────── */

test('linking a transaction tags it without touching the money', () => {
  let state = stateWithPlan();
  const cardId = account(state, 'BDO Gold').id;
  state = actions.addTransaction(state, {
    date: '2026-06-05', accountId: cardId, payee: 'Appliance — SM Megamall', amount: -2_000_00, kind: 'expense',
  });
  const txId = state.transactions[0].id;
  const planId = plan(state).id;

  const next = actions.linkInstallmentTransaction(state, { installmentId: planId, transactionId: txId });
  const tx = must(next.transactions.find((t) => t.id === txId), 'the transaction');
  assert.equal(tx.installmentId, planId);
  assert.equal(tx.amount, -2_000_00, 'linking changes nothing about the charge itself');

  // Purely a label: the calendar-derived progress does not move because a
  // charge was tagged, and reads exactly the same if it never had been.
  assert.deepEqual(
    installmentSnapshot(plan(next), '2026-06'),
    installmentSnapshot(plan(state), '2026-06'),
  );
});

test('linking is refused across cards, and for an unknown plan or transaction', () => {
  let state = stateWithPlan();
  const cardId = account(state, 'BDO Gold').id;
  const planId = plan(state).id;
  state = actions.addAccount(state, { name: 'Other Card', type: 'credit', creditLimit: 100_000_00, openedOn: '2026-04-01' });
  const otherId = account(state, 'Other Card').id;
  state = actions.addTransaction(state, {
    date: '2026-06-05', accountId: otherId, payee: 'Somewhere else', amount: -2_000_00, kind: 'expense',
  });
  const txOnOtherCard = state.transactions[0].id;

  assert.equal(
    actions.linkInstallmentTransaction(state, { installmentId: planId, transactionId: txOnOtherCard }),
    state,
    'a charge on a different card cannot belong to this plan',
  );

  state = actions.addTransaction(state, {
    date: '2026-06-05', accountId: cardId, payee: 'Appliance', amount: -2_000_00, kind: 'expense',
  });
  const txId = state.transactions[1].id;
  assert.equal(
    actions.linkInstallmentTransaction(state, { installmentId: 'missing', transactionId: txId }),
    state,
  );
  assert.equal(
    actions.linkInstallmentTransaction(state, { installmentId: planId, transactionId: 'missing' }),
    state,
  );
});

test('unlinking detaches the tag, and the money stays exactly where it is', () => {
  let state = stateWithPlan();
  const cardId = account(state, 'BDO Gold').id;
  state = actions.addTransaction(state, {
    date: '2026-06-05', accountId: cardId, payee: 'Appliance', amount: -2_000_00, kind: 'expense',
  });
  const txId = state.transactions[0].id;
  state = actions.linkInstallmentTransaction(state, { installmentId: plan(state).id, transactionId: txId });
  assert.ok(must(state.transactions.find((t) => t.id === txId), 'the transaction').installmentId);

  const next = actions.unlinkInstallmentTransaction(state, txId);
  const tx = must(next.transactions.find((t) => t.id === txId), 'the transaction');
  assert.equal(tx.installmentId, null);
  assert.equal(tx.amount, -2_000_00);
});

test('stopping a plan clears the tag from whatever it was linked to', () => {
  let state = stateWithPlan();
  const cardId = account(state, 'BDO Gold').id;
  state = actions.addTransaction(state, {
    date: '2026-06-05', accountId: cardId, payee: 'Appliance', amount: -2_000_00, kind: 'expense',
  });
  const txId = state.transactions[0].id;
  state = actions.linkInstallmentTransaction(state, { installmentId: plan(state).id, transactionId: txId });

  const next = actions.deleteInstallment(state, plan(state).id);
  assert.deepEqual(next.installments, []);
  const tx = must(next.transactions.find((t) => t.id === txId), 'the transaction');
  assert.equal(tx.installmentId, null, 'nothing dangles once the plan is gone');
  assert.equal(tx.amount, -2_000_00, 'the charge itself is untouched');
});

test('deleting a card takes its plans with it', () => {
  const state = stateWithPlan();
  const next = actions.deleteAccount(state, account(state, 'BDO Gold').id);
  assert.deepEqual(next.installments, []);
});

test('plans survive a backup round trip, and a backup without them still loads', () => {
  const state = stateWithPlan();
  const restored = actions.fromBackup(actions.toBackup(state));
  assert.equal(restored.installments.length, 1);
  assert.equal(installmentSnapshot(plan(restored), '2026-06').billed, 3);

  const older = JSON.parse(actions.toBackup(state));
  delete older.installments;
  assert.deepEqual(actions.fromBackup(JSON.stringify(older)).installments, []);
});

/* ── Reading a plan off a statement ───────────────────────────────────── */

test('the instalment marker is read in the forms issuers print', () => {
  assert.deepEqual(parseInstallmentMarker('INSTALLMENT - APPLIANCE 3/12'), { index: 3, total: 12 });
  assert.deepEqual(parseInstallmentMarker('Inst 03/24 Sofa'), { index: 3, total: 24 });
  assert.deepEqual(parseInstallmentMarker('LAPTOP 1 of 6'), { index: 1, total: 6 });
});

test('things that merely look like a fraction are not instalments', () => {
  // A date, a ratio the wrong way round, and a term nobody offers.
  // A date: "the sixth of eighteen" is a perfectly good reading of 06/18, which
  // is exactly why a bare fraction needs the row to say it is an instalment.
  assert.equal(parseInstallmentMarker('PAYMENT 06/18'), null);
  assert.equal(parseInstallmentMarker('SM MEGAMALL 3/12'), null, 'no instalment wording');
  assert.deepEqual(parseInstallmentMarker('SM MEGAMALL INSTALLMENT 3/12'), { index: 3, total: 12 });
  assert.equal(parseInstallmentMarker('INSTALLMENT 13/12'), null, 'past the end of its own term');
  assert.equal(parseInstallmentMarker('THING 1/1'), null, 'a single instalment is not a plan');
  assert.equal(parseInstallmentMarker('NO NUMBERS HERE'), null);
});

test('a plan is recovered from any single statement, not just the first', () => {
  // The third of twelve, billed in June, must have started in April.
  const recovered = must(
    planFromStatementRow(
      { description: 'Installment - Appliance 3/12', amount: 2_000_00, date: '2026-06-15' },
      'card-1',
    ),
    'the recovered plan',
  );
  assert.equal(recovered.startMonth, '2026-04');
  assert.equal(recovered.months, 12);
  assert.equal(recovered.monthlyAmount, 2_000_00);
  assert.equal(recovered.description, 'Installment - Appliance', 'the marker is not part of the name');
});

test('a plan already tracked is not offered again', () => {
  const state = stateWithPlan();
  const cardId = account(state, 'BDO Gold').id;
  const fromStatement = must(
    planFromStatementRow(
      { description: 'Installment - Appliance — SM Megamall 3/12', amount: 2_000_00, date: '2026-06-15' },
      cardId,
    ),
    'the recovered plan',
  );
  assert.ok(findMatchingPlan(state, fromStatement), 'the same plan is recognised');

  const different = { ...fromStatement, monthlyAmount: 999_00 };
  assert.equal(findMatchingPlan(state, different), null);
});
