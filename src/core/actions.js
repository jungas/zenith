/**
 * State transitions. Every function takes state and returns *new* state —
 * nothing here mutates, so undo is just keeping the previous object.
 */

import {
  ensurePaymentCategories, isCredit, makeAccount, makeCategory, makeTransaction,
  newId, paymentCategoryFor,
} from './model.js';
import { monthOf, todayISO } from './dates.js';

/* ── Accounts ─────────────────────────────────────────────────────────── */

export function addAccount(state, patch) {
  const account = makeAccount({
    ...patch,
    openedOn: patch.openedOn || todayISO(),
    sort: state.accounts.length,
  });
  return ensurePaymentCategories({ ...state, accounts: [...state.accounts, account] });
}

export function updateAccount(state, accountId, patch) {
  const accounts = state.accounts.map((a) => (a.id === accountId ? { ...a, ...patch } : a));
  return ensurePaymentCategories({ ...state, accounts });
}

/**
 * Deleting an account removes its transactions and, for a card, its payment
 * envelope. Any transfer that pointed at it loses its partner leg too —
 * a half-transfer would silently unbalance every total in the app.
 */
export function deleteAccount(state, accountId) {
  const doomedTransfers = new Set(
    state.transactions.filter((t) => t.accountId === accountId && t.transferId).map((t) => t.transferId),
  );
  const transactions = state.transactions.filter(
    (t) => t.accountId !== accountId && !(t.transferId && doomedTransfers.has(t.transferId)),
  );
  const categories = state.categories.filter(
    (c) => !(c.kind === 'ccPayment' && c.accountId === accountId),
  );
  const removedCategoryIds = new Set(
    state.categories.filter((c) => c.kind === 'ccPayment' && c.accountId === accountId).map((c) => c.id),
  );
  return {
    ...state,
    accounts: state.accounts.filter((a) => a.id !== accountId),
    categories,
    budgets: stripCategories(state.budgets, removedCategoryIds),
    transactions: transactions.map((t) =>
      removedCategoryIds.has(t.categoryId) ? { ...t, categoryId: null } : t,
    ),
  };
}

/* ── Categories ───────────────────────────────────────────────────────── */

export function addCategory(state, patch) {
  const category = makeCategory({ ...patch, sort: state.categories.length });
  return { ...state, categories: [...state.categories, category] };
}

export function updateCategory(state, categoryId, patch) {
  return {
    ...state,
    categories: state.categories.map((c) => (c.id === categoryId ? { ...c, ...patch } : c)),
  };
}

/**
 * Payment envelopes are structural — they are deleted with their card, never
 * on their own, or card spending would have nowhere to reserve cash.
 */
export function deleteCategory(state, categoryId) {
  const category = state.categories.find((c) => c.id === categoryId);
  if (!category || category.kind === 'ccPayment') return state;
  return {
    ...state,
    categories: state.categories.filter((c) => c.id !== categoryId),
    budgets: stripCategories(state.budgets, new Set([categoryId])),
    transactions: state.transactions.map((t) =>
      t.categoryId === categoryId ? { ...t, categoryId: null } : t,
    ),
  };
}

function stripCategories(budgets, categoryIds) {
  const next = {};
  for (const [month, row] of Object.entries(budgets || {})) {
    const kept = {};
    for (const [categoryId, cents] of Object.entries(row)) {
      if (!categoryIds.has(categoryId)) kept[categoryId] = cents;
    }
    next[month] = kept;
  }
  return next;
}

/* ── Budgeting ────────────────────────────────────────────────────────── */

export function setBudget(state, month, categoryId, cents) {
  const row = { ...(state.budgets[month] || {}) };
  if (!cents) delete row[categoryId];
  else row[categoryId] = Math.round(cents);
  return { ...state, budgets: { ...state.budgets, [month]: row } };
}

/** Move assigned money from one envelope to another within a month. */
export function moveBudget(state, month, fromCategoryId, toCategoryId, cents) {
  if (!cents || fromCategoryId === toCategoryId) return state;
  const row = state.budgets[month] || {};
  let next = setBudget(state, month, fromCategoryId, (row[fromCategoryId] || 0) - cents);
  next = setBudget(next, month, toCategoryId, (next.budgets[month][toCategoryId] || 0) + cents);
  return next;
}

/* ── Transactions ─────────────────────────────────────────────────────── */

/**
 * Record spending or income.
 * `amount` is signed cents from the account's point of view: an expense on a
 * credit card is negative, and increases what the card owes.
 */
export function addTransaction(state, patch) {
  const kind = patch.kind || (patch.amount > 0 ? 'income' : 'expense');
  const transaction = makeTransaction({
    ...patch,
    kind,
    date: patch.date || todayISO(),
    categoryId: kind === 'income' ? null : patch.categoryId ?? null,
  });
  return { ...state, transactions: [...state.transactions, transaction] };
}

export function updateTransaction(state, transactionId, patch) {
  const existing = state.transactions.find((t) => t.id === transactionId);
  if (!existing) return state;

  // Editing one leg of a transfer must keep the mirror leg in step.
  if (existing.transferId && (patch.amount != null || patch.date)) {
    const transactions = state.transactions.map((t) => {
      if (t.id === transactionId) return { ...t, ...patch };
      if (t.transferId !== existing.transferId) return t;
      return {
        ...t,
        ...(patch.date ? { date: patch.date } : {}),
        ...(patch.amount != null ? { amount: -patch.amount } : {}),
      };
    });
    return { ...state, transactions };
  }

  return {
    ...state,
    transactions: state.transactions.map((t) => (t.id === transactionId ? { ...t, ...patch } : t)),
  };
}

export function deleteTransaction(state, transactionId) {
  const existing = state.transactions.find((t) => t.id === transactionId);
  if (!existing) return state;
  const transactions = existing.transferId
    ? state.transactions.filter((t) => t.transferId !== existing.transferId)
    : state.transactions.filter((t) => t.id !== transactionId);
  return { ...state, transactions };
}

/**
 * Move money between two accounts as a linked pair of legs.
 *
 * When the destination is a credit card this *is* a card payment: the outflow
 * leg is categorised to the card's payment envelope, which draws down the cash
 * that card spending reserved. That single line is the whole connection
 * between the budget and the debt.
 */
export function addTransfer(state, { fromAccountId, toAccountId, amount, date, payee, memo, cleared }) {
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId || !amount) return state;
  const cents = Math.abs(Math.round(amount));
  const transferId = newId('xfer');
  const when = date || todayISO();
  const to = state.accounts.find((a) => a.id === toAccountId);
  const from = state.accounts.find((a) => a.id === fromAccountId);

  const paymentCategory = to && isCredit(to) ? paymentCategoryFor(state, to.id) : null;
  // Paying *from* a card is a cash advance: it draws on the card's own credit,
  // so nothing is categorised — the debt simply grows.
  const label = payee || (paymentCategory ? `Payment to ${to.name}` : `Transfer to ${to?.name ?? 'account'}`);

  const outflow = makeTransaction({
    date: when,
    accountId: fromAccountId,
    categoryId: paymentCategory?.id ?? null,
    payee: label,
    memo: memo || '',
    amount: -cents,
    kind: 'transfer',
    cleared: cleared ?? false,
    transferId,
  });
  const inflow = makeTransaction({
    date: when,
    accountId: toAccountId,
    categoryId: null,
    payee: payee || `Transfer from ${from?.name ?? 'account'}`,
    memo: memo || '',
    amount: cents,
    kind: 'transfer',
    cleared: cleared ?? false,
    transferId,
  });

  return { ...state, transactions: [...state.transactions, outflow, inflow] };
}

/** Convenience wrapper used by the card views. */
export function payCard(state, { cardId, fromAccountId, amount, date, memo }) {
  return addTransfer(state, {
    fromAccountId,
    toAccountId: cardId,
    amount,
    date,
    memo,
    payee: `Payment to ${state.accounts.find((a) => a.id === cardId)?.name ?? 'card'}`,
  });
}

/* ── Import / export ──────────────────────────────────────────────────── */

export function toBackup(state) {
  return JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
}

export function fromBackup(json) {
  const parsed = typeof json === 'string' ? JSON.parse(json) : json;
  if (!parsed || typeof parsed !== 'object') throw new Error('That file is not a Zenith backup.');
  for (const key of ['accounts', 'categories', 'transactions']) {
    if (!Array.isArray(parsed[key])) throw new Error(`Backup is missing "${key}".`);
  }
  if (!parsed.budgets || typeof parsed.budgets !== 'object') parsed.budgets = {};
  delete parsed.exportedAt;
  return ensurePaymentCategories(parsed);
}

/** Transactions as CSV, newest first. */
export function toCsv(state) {
  const accounts = new Map(state.accounts.map((a) => [a.id, a.name]));
  const categories = new Map(state.categories.map((c) => [c.id, c.name]));
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Account', 'Payee', 'Category', 'Memo', 'Amount', 'Kind', 'Cleared']];
  const sorted = [...state.transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const tx of sorted) {
    rows.push([
      tx.date,
      accounts.get(tx.accountId) ?? '',
      tx.payee,
      categories.get(tx.categoryId) ?? '',
      tx.memo,
      (tx.amount / 100).toFixed(2),
      tx.kind,
      tx.cleared ? 'yes' : 'no',
    ].map(escape));
  }
  return rows.map((row) => row.join(',')).join('\n');
}

export const monthOfTransaction = (tx) => monthOf(tx.date);
