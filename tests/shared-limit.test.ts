/**
 * Credit limits shared across several cards from one bank.
 *
 * Two things are being pinned here. The **arithmetic**: a shared limit is one
 * allowance, so utilisation and available credit are measured against the
 * combined balance, and the portfolio total counts the limit once however many
 * cards draw on it. And the **rule**: a shared limit belongs to a bank, so a
 * group can never span two issuers — enforced in the actions rather than only
 * in the form, because a backup can be hand-edited and a form cannot guard that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as actions from '../src/core/actions.ts';
import { emptyState, sharedLimitFor, sharedLimitMembers, canJoinSharedLimit } from '../src/core/model.ts';
import type { AppState, CreditAccount } from '../src/core/model.ts';
import {
  annualFromMonthly, cardSnapshot, debtSummary, monthlyFromAnnual, monthlyInterest, quotedRate,
} from '../src/core/cards.ts';
import { account, must } from './helpers.ts';

const MONTH = '2026-06';

/** Two BDO cards and one BPI card, none of them sharing anything yet. */
function baseState(): AppState {
  let state = emptyState(new Date(2026, 5, 1));
  state = actions.addAccount(state, {
    name: 'Everyday Checking', type: 'checking', openingBalance: 100_000_00, openedOn: '2026-06-01',
  });
  state = actions.addAccount(state, {
    name: 'BDO Gold', type: 'credit', provider: 'BDO', creditLimit: 200_000_00, openedOn: '2026-06-01',
  });
  state = actions.addAccount(state, {
    name: 'BDO Platinum', type: 'credit', provider: 'BDO', creditLimit: 200_000_00, openedOn: '2026-06-01',
  });
  state = actions.addAccount(state, {
    name: 'BPI Rewards', type: 'credit', provider: 'BPI', creditLimit: 80_000_00, openedOn: '2026-06-01',
  });
  return state;
}

const card = (state: AppState, name: string): CreditAccount => {
  const found = account(state, name);
  if (found.type !== 'credit') throw new Error(`${name} is not a card`);
  return found;
};

/** Put the two BDO cards on one 200,000 limit. */
function withSharedBdo(state: AppState = baseState()): AppState {
  return actions.shareLimitWith(state, card(state, 'BDO Gold').id, card(state, 'BDO Platinum').id, {
    creditLimit: 200_000_00,
  });
}

const spend = (state: AppState, name: string, cents: number): AppState =>
  actions.addTransaction(state, {
    date: '2026-06-05', accountId: card(state, name).id, payee: 'Shop', amount: -cents, kind: 'expense',
  });

/* ── The rule ─────────────────────────────────────────────────────────── */

test('two cards from the same bank can share a limit', () => {
  const state = withSharedBdo();
  const gold = card(state, 'BDO Gold');
  const platinum = card(state, 'BDO Platinum');

  const limit = must(sharedLimitFor(state, gold), 'the shared limit');
  assert.equal(limit.provider, 'BDO');
  assert.equal(limit.creditLimit, 200_000_00);
  assert.equal(platinum.sharedLimitId, limit.id);
  assert.deepEqual(sharedLimitMembers(state, limit.id).map((c) => c.name), ['BDO Gold', 'BDO Platinum']);
});

test('cards from different banks cannot share a limit', () => {
  const state = baseState();
  const next = actions.shareLimitWith(state, card(state, 'BDO Gold').id, card(state, 'BPI Rewards').id, {
    creditLimit: 200_000_00,
  });
  assert.equal(next, state, 'the state should be untouched');
  assert.equal(next.sharedLimits.length, 0);
});

test('a card with no bank recorded cannot join anything', () => {
  let state = baseState();
  state = actions.addAccount(state, { name: 'Mystery Card', type: 'credit', creditLimit: 10_000_00 });
  const shared = withSharedBdo(state);
  const limit = must(shared.sharedLimits[0], 'the shared limit');

  const mystery = card(shared, 'Mystery Card');
  assert.equal(canJoinSharedLimit(shared, mystery, limit.id), false);
  assert.equal(actions.joinSharedLimit(shared, mystery.id, limit.id), shared);
});

test('joining directly is refused when the banks differ', () => {
  const state = withSharedBdo();
  const limit = must(state.sharedLimits[0], 'the shared limit');
  const bpi = card(state, 'BPI Rewards');
  assert.equal(canJoinSharedLimit(state, bpi, limit.id), false);
  assert.equal(actions.joinSharedLimit(state, bpi.id, limit.id), state);
});

test('changing a card to another bank takes it off the shared limit', () => {
  const state = withSharedBdo();
  const gold = card(state, 'BDO Gold');
  // The card is now a Metrobank card, so it cannot be on BDO's shared limit.
  const next = actions.updateAccount(state, gold.id, { provider: 'Metrobank' });

  assert.equal(card(next, 'BDO Gold').sharedLimitId, null);
  // One card left is not sharing anything, so the group dissolves and the
  // survivor keeps the limit rather than losing the figure.
  assert.equal(next.sharedLimits.length, 0);
  assert.equal(card(next, 'BDO Platinum').creditLimit, 200_000_00);
});

/* ── The arithmetic ───────────────────────────────────────────────────── */

test('utilisation is measured against the combined balance', () => {
  let state = withSharedBdo();
  state = spend(state, 'BDO Gold', 30_000_00);
  state = spend(state, 'BDO Platinum', 50_000_00);

  const gold = cardSnapshot(state, card(state, 'BDO Gold'), { month: MONTH });
  assert.equal(gold.balance, 30_000_00, 'this card still owes only its own charges');
  assert.equal(gold.limitBalance, 80_000_00, 'but the limit sees both cards');
  assert.equal(gold.creditLimit, 200_000_00);
  assert.equal(gold.availableCredit, 120_000_00);
  assert.equal(gold.utilization, 0.4);

  // Both cards report the same standing, because there is only one limit.
  const platinum = cardSnapshot(state, card(state, 'BDO Platinum'), { month: MONTH });
  assert.equal(platinum.availableCredit, gold.availableCredit);
  assert.equal(platinum.utilization, gold.utilization);
  assert.equal(platinum.balance, 50_000_00);
});

test('spending on a sibling card reduces this card’s available credit', () => {
  const shared = withSharedBdo();
  const before = cardSnapshot(shared, card(shared, 'BDO Gold'), { month: MONTH });
  const after = cardSnapshot(spend(shared, 'BDO Platinum', 25_000_00), card(shared, 'BDO Gold'), {
    month: MONTH,
  });

  assert.equal(before.availableCredit - after.availableCredit, 25_000_00);
  assert.equal(after.balance, 0, 'without adding anything to this card');
});

test('an instalment plan on one card eats into a sibling’s headroom too', () => {
  let state = withSharedBdo();
  state = actions.addInstallment(state, {
    accountId: card(state, 'BDO Platinum').id,
    description: 'Refrigerator', monthlyAmount: 2_000_00, months: 10, startMonth: MONTH,
  });

  const gold = cardSnapshot(state, card(state, 'BDO Gold'), { month: MONTH });
  const platinum = cardSnapshot(state, card(state, 'BDO Platinum'), { month: MONTH });
  // 9 months left after this one, on a limit neither card has touched with a
  // charge — the commitment alone is what moves it.
  assert.equal(platinum.instalmentCommitted, 18_000_00);
  assert.equal(gold.availableCredit, 200_000_00 - 18_000_00);
  assert.equal(gold.availableCredit, platinum.availableCredit, 'one shared limit, one figure');
});

test('an unshared card is unaffected by the others', () => {
  let state = withSharedBdo();
  state = spend(state, 'BDO Gold', 30_000_00);
  const bpi = cardSnapshot(state, card(state, 'BPI Rewards'), { month: MONTH });
  assert.equal(bpi.sharedLimit, null);
  assert.equal(bpi.availableCredit, 80_000_00);
  assert.deepEqual(bpi.siblings, []);
});

test('a shared limit is counted once in the portfolio total', () => {
  let state = withSharedBdo();
  state = spend(state, 'BDO Gold', 30_000_00);
  state = spend(state, 'BDO Platinum', 50_000_00);
  state = spend(state, 'BPI Rewards', 8_000_00);

  const debt = debtSummary(state, { month: MONTH });
  // 200,000 shared between the two BDO cards, plus BPI's own 80,000 — not
  // 480,000, which is what summing each card's own figure would give.
  assert.equal(debt.limit, 280_000_00);
  assert.equal(debt.balance, 88_000_00);
  assert.equal(debt.utilization, 88_000_00 / 280_000_00);
});

test('the balance owed on each card is still its own', () => {
  let state = withSharedBdo();
  state = spend(state, 'BDO Gold', 30_000_00);
  state = spend(state, 'BDO Platinum', 50_000_00);

  // A shared limit shares the *limit*, not the debt: each card is billed for
  // what was spent on it, so minimum payments and statements stay separate.
  const gold = cardSnapshot(state, card(state, 'BDO Gold'), { month: MONTH });
  const platinum = cardSnapshot(state, card(state, 'BDO Platinum'), { month: MONTH });
  assert.equal(gold.balance, 30_000_00);
  assert.equal(platinum.balance, 50_000_00);
  assert.notEqual(gold.paymentCategory?.id, platinum.paymentCategory?.id);
});

/* ── Leaving ──────────────────────────────────────────────────────────── */

test('a card leaving keeps a limit of its own', () => {
  const state = withSharedBdo();
  const next = actions.leaveSharedLimit(state, card(state, 'BDO Gold').id);

  assert.equal(card(next, 'BDO Gold').sharedLimitId, null);
  assert.equal(card(next, 'BDO Gold').creditLimit, 200_000_00);
  // The other card is no longer sharing with anyone either.
  assert.equal(next.sharedLimits.length, 0);
  assert.equal(card(next, 'BDO Platinum').creditLimit, 200_000_00);

  const gold = cardSnapshot(next, card(next, 'BDO Gold'), { month: MONTH });
  assert.equal(gold.sharedLimit, null);
  assert.equal(gold.availableCredit, 200_000_00);
});

test('deleting a card dissolves a limit it was sharing with one other', () => {
  let state = withSharedBdo();
  state = actions.deleteAccount(state, card(state, 'BDO Gold').id);
  assert.equal(state.sharedLimits.length, 0);
  assert.equal(card(state, 'BDO Platinum').creditLimit, 200_000_00);
});

test('a third card can join, and the group survives one leaving', () => {
  let state = withSharedBdo();
  state = actions.addAccount(state, {
    name: 'BDO Titanium', type: 'credit', provider: 'BDO', creditLimit: 0, openedOn: '2026-06-01',
  });
  const limit = must(state.sharedLimits[0], 'the shared limit');
  state = actions.joinSharedLimit(state, card(state, 'BDO Titanium').id, limit.id);
  assert.equal(sharedLimitMembers(state, limit.id).length, 3);

  state = actions.leaveSharedLimit(state, card(state, 'BDO Titanium').id);
  assert.equal(state.sharedLimits.length, 1, 'two cards still share it');
  assert.equal(sharedLimitMembers(state, limit.id).length, 2);
});

/* ── Persistence ──────────────────────────────────────────────────────── */

test('shared limits survive a backup round trip', () => {
  let state = withSharedBdo();
  state = spend(state, 'BDO Gold', 30_000_00);
  const restored = actions.fromBackup(actions.toBackup(state));

  const limit = must(sharedLimitFor(restored, card(restored, 'BDO Gold')), 'the restored limit');
  assert.equal(limit.creditLimit, 200_000_00);
  assert.equal(sharedLimitMembers(restored, limit.id).length, 2);
  assert.equal(
    cardSnapshot(restored, card(restored, 'BDO Gold'), { month: MONTH }).availableCredit,
    170_000_00,
  );
});

test('a backup with a group spanning two banks is repaired on import', () => {
  // Nothing in the app can produce this, but a hand-edited file can — and a
  // group spanning two issuers would report credit that does not exist.
  const state = withSharedBdo();
  const limit = must(state.sharedLimits[0], 'the shared limit');
  const tampered = {
    ...state,
    accounts: state.accounts.map((a) =>
      a.name === 'BPI Rewards' ? { ...a, sharedLimitId: limit.id } : a,
    ),
  };

  const repaired = actions.fromBackup(JSON.stringify(tampered));
  assert.equal(card(repaired, 'BPI Rewards').sharedLimitId, null);
  assert.equal(sharedLimitMembers(repaired, limit.id).length, 2, 'only the two BDO cards remain');
  assert.equal(card(repaired, 'BPI Rewards').creditLimit, 80_000_00, 'it keeps its own limit');
});

test('a backup from before shared limits existed still loads', () => {
  const state = baseState();
  const older = JSON.parse(actions.toBackup(state));
  delete older.sharedLimits;

  const restored = actions.fromBackup(JSON.stringify(older));
  assert.deepEqual(restored.sharedLimits, []);
  assert.equal(
    cardSnapshot(restored, card(restored, 'BDO Gold'), { month: MONTH }).availableCredit,
    200_000_00,
  );
});

/* ── Interest rates as the issuer quotes them ─────────────────────────── */

test('a monthly rate is stored annually and shown monthly', () => {
  let state = baseState();
  // Philippine banks quote per month: a BDO statement says 3.5%, not 42%.
  state = actions.updateAccount(state, card(state, 'BDO Gold').id, {
    apr: annualFromMonthly(0.035),
    rateBasis: 'monthly',
  });

  const bdo = card(state, 'BDO Gold');
  assert.equal(Math.round(bdo.apr * 10000) / 10000, 0.42, 'stored as the annual figure');
  assert.deepEqual(quotedRate(bdo), { rate: 0.035, basis: 'monthly' });

  // The projection is exactly the rate the statement quotes, on the balance.
  assert.equal(monthlyInterest(100_000_00, bdo.apr), 3_500_00);
});

test('an annual rate is unchanged and still reads annually', () => {
  let state = baseState();
  state = actions.updateAccount(state, card(state, 'BPI Rewards').id, { apr: 0.1999 });
  const bpi = card(state, 'BPI Rewards');
  assert.deepEqual(quotedRate(bpi), { rate: 0.1999, basis: 'annual' });
  assert.equal(monthlyFromAnnual(0.24), 0.02);
  assert.equal(annualFromMonthly(0.03), 0.36);
});
