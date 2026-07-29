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
