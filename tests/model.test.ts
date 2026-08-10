/**
 * Duplicate-name checks for the entities a person names by hand.
 *
 * These sit in `core/model.ts` rather than the form itself so the rule — case-
 * and spacing-insensitive, editing a record never collides with itself — is
 * exercised without going through the DOM.
 *
 * Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  accountNameTaken, categoryNameTaken, emptyState, sameName,
} from '../src/core/model.ts';
import type { AppState } from '../src/core/model.ts';
import * as actions from '../src/core/actions.ts';
import { account, category, creditAccount, paymentEnvelope } from './helpers.ts';

test('sameName ignores case and surrounding space', () => {
  assert.equal(sameName('Groceries', 'groceries'), true);
  assert.equal(sameName(' Groceries ', 'groceries'), true);
  assert.equal(sameName('Groceries', 'Dining'), false);
  assert.equal(sameName(undefined, ''), true);
});

/* ── Categories ───────────────────────────────────────────────────────── */

function stateWithCategory(): AppState {
  let state = emptyState(new Date('2026-05-01T00:00:00Z'));
  state = actions.addCategory(state, { name: 'Groceries', group: 'Everyday' });
  return state;
}

test('a new category cannot reuse a name already in use', () => {
  const state = stateWithCategory();
  assert.equal(categoryNameTaken(state, 'Groceries'), true);
  assert.equal(categoryNameTaken(state, ' groceries '), true, 'case and spacing are ignored');
  assert.equal(categoryNameTaken(state, 'Dining'), false);
});

test('editing a category does not collide with itself', () => {
  const state = stateWithCategory();
  const existing = category(state, 'Groceries');
  assert.equal(categoryNameTaken(state, 'Groceries', { excludeId: existing.id }), false);
});

test('a card payment envelope never counts as a name collision', () => {
  let state = stateWithCategory();
  state = actions.addAccount(state, {
    name: 'Visa', type: 'credit', openingBalance: 0, openedOn: '2026-05-01',
    creditLimit: 500_000, apr: 0.2, statementDay: 18, dueDay: 12,
  });
  const envelope = paymentEnvelope(state, creditAccount(state, 'Visa').id);
  // A spending category is free to reuse a payment envelope's name — they are
  // never shown side by side and the envelope is not offered as a name to type.
  assert.equal(categoryNameTaken(state, envelope.name), false);
});

/* ── Accounts ─────────────────────────────────────────────────────────── */

function stateWithAccount(): AppState {
  let state = emptyState(new Date('2026-05-01T00:00:00Z'));
  state = actions.addAccount(state, { name: 'Checking', type: 'checking', openingBalance: 500_000 });
  return state;
}

test('a new account cannot reuse a name already in use', () => {
  const state = stateWithAccount();
  assert.equal(accountNameTaken(state, 'Checking'), true);
  assert.equal(accountNameTaken(state, ' checking '), true, 'case and spacing are ignored');
  assert.equal(accountNameTaken(state, 'Savings'), false);
});

test('editing an account does not collide with itself', () => {
  const state = stateWithAccount();
  const existing = account(state, 'Checking');
  assert.equal(accountNameTaken(state, 'Checking', { excludeId: existing.id }), false);
});

test('the collision holds across account types, not just within one', () => {
  let state = stateWithAccount();
  state = actions.addAccount(state, {
    name: 'Visa', type: 'credit', openingBalance: 0, creditLimit: 500_000, apr: 0.2,
  });
  assert.equal(accountNameTaken(state, 'Visa'), true);
});
