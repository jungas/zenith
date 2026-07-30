/**
 * Savings accounts: the p.a. rate a user types in, and what it projects.
 *
 * A savings account never bills anything, so there is no envelope or
 * schedule to keep in step here — just a rate on a balance, the same shape
 * as a card's or loan's interest cost but running the other way.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as actions from '../src/core/actions.ts';
import { emptyState } from '../src/core/model.ts';
import type { AppState } from '../src/core/model.ts';
import { savingsSnapshot, savingsSnapshots, savingsTotals } from '../src/core/savings.ts';
import { account, savingsAccount } from './helpers.ts';

/** Chequing plus an Emergency Fund savings account paying 2.4% p.a. */
function fixture(): AppState {
  let state = emptyState(new Date(2026, 5, 1));
  state = actions.addAccount(state, {
    name: 'Chequing', type: 'checking', openingBalance: 100_000_00, openedOn: '2026-06-01',
  });
  state = actions.addAccount(state, {
    name: 'Emergency Fund', type: 'savings', provider: 'BPI',
    openingBalance: 240_000_00, openedOn: '2026-06-01', interestRate: 0.024,
  });
  return state;
}

test('a typed p.a. rate is stored as an annual decimal', () => {
  const state = fixture();
  const savings = savingsAccount(state, 'Emergency Fund');
  assert.equal(savings.interestRate, 0.024);
});

test('a savings snapshot projects monthly and annual interest off the balance', () => {
  const state = fixture();
  const snapshot = savingsSnapshot(state, savingsAccount(state, 'Emergency Fund'));
  assert.equal(snapshot.balance, 240_000_00);
  assert.equal(snapshot.annualRate, 0.024);
  // 240,000 * 0.024 / 12 = 480.00
  assert.equal(snapshot.monthlyInterest, 480_00);
  // 240,000 * 0.024 = 5,760.00
  assert.equal(snapshot.annualInterest, 5_760_00);
});

test('a savings account with no rate set projects nothing', () => {
  let state = fixture();
  state = actions.addAccount(state, {
    name: 'Piggy bank', type: 'savings', openingBalance: 10_000_00, openedOn: '2026-06-01',
  });
  const snapshot = savingsSnapshot(state, savingsAccount(state, 'Piggy bank'));
  assert.equal(snapshot.annualRate, 0);
  assert.equal(snapshot.monthlyInterest, 0);
  assert.equal(snapshot.annualInterest, 0);
});

test('totals sum every savings account, and skip everything else', () => {
  let state = fixture();
  state = actions.addAccount(state, {
    name: 'Vacation fund', type: 'savings', openingBalance: 60_000_00, openedOn: '2026-06-01',
    interestRate: 0.01,
  });
  const totals = savingsTotals(state);
  assert.deepEqual(
    savingsSnapshots(state).map((s) => s.account.name),
    ['Emergency Fund', 'Vacation fund'],
  );
  assert.equal(totals.balance, 300_000_00);
  // 480.00 + (60,000 * 0.01 / 12 = 50.00) = 530.00
  assert.equal(totals.monthlyInterest, 530_00);
});

/* ── The type is kept honest ──────────────────────────────────────────── */

test('a p.a. rate does not leak onto other account types', () => {
  let state = fixture();
  state = actions.addAccount(state, {
    name: 'Chequing 2', type: 'checking', interestRate: 0.05,
  });
  const chequing = account(state, 'Chequing 2');
  assert.equal('interestRate' in chequing, false);
});

test('editing a savings account keeps its type and lets the rate be updated', () => {
  let state = fixture();
  const savings = savingsAccount(state, 'Emergency Fund');
  state = actions.updateAccount(state, savings.id, { interestRate: 0.03 });
  const updated = savingsAccount(state, 'Emergency Fund');
  assert.equal(updated.type, 'savings');
  assert.equal(updated.interestRate, 0.03);
});

test('a savings account survives a backup round trip', () => {
  const restored = actions.fromBackup(actions.toBackup(fixture()));
  const savings = savingsAccount(restored, 'Emergency Fund');
  assert.equal(savings.interestRate, 0.024);
  assert.equal(savings.openingBalance, 240_000_00);
});
