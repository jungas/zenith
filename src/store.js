/**
 * The store: one state object, localStorage persistence, a subscribe/notify
 * loop, and a one-level undo stack.
 *
 * localStorage rather than IndexedDB is a deliberate trade: the whole budget is
 * a few hundred KB of JSON, reads are synchronous (so rendering never has to
 * await), and export/import is a single `JSON.stringify`.
 */

import { emptyState, ensurePaymentCategories, SCHEMA_VERSION } from './core/model.js';

const STORAGE_KEY = 'zenith.state.v1';
const UNDO_LIMIT = 25;

const listeners = new Set();
const undoStack = [];
let state = load();
let persistTimer = null;

function load() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    return migrate(parsed);
  } catch (error) {
    console.warn('Could not read saved data, starting fresh.', error);
    return emptyState();
  }
}

function migrate(parsed) {
  const base = emptyState();
  const next = {
    ...base,
    ...parsed,
    version: SCHEMA_VERSION,
    settings: { ...base.settings, ...(parsed.settings || {}) },
    accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
    categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
    budgets: parsed.budgets && typeof parsed.budgets === 'object' ? parsed.budgets : {},
  };
  return ensurePaymentCategories(next);
}

/** Writes are debounced — a slider drag shouldn't hit disk 60 times a second. */
function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.error('Saving failed — device storage may be full.', error);
      notifyError('Could not save. Your device storage may be full.');
    }
  }, 120);
}

let errorHandler = null;
export function onPersistError(handler) {
  errorHandler = handler;
}
function notifyError(message) {
  errorHandler?.(message);
}

export function getState() {
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of [...listeners]) listener(state);
}

/**
 * Apply a transition. `mutator` receives state and returns the next state.
 * @param {(state: object) => object} mutator
 * @param {{undoable?: boolean, label?: string}} [opts]
 */
export function commit(mutator, opts = {}) {
  const { undoable = true, label = 'change' } = opts;
  const next = mutator(state);
  if (!next || next === state) return state;
  if (undoable) {
    undoStack.push({ state, label });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }
  state = next;
  persist();
  notify();
  return state;
}

/** Replace state wholesale (import, sample data, reset). */
export function replaceState(next, { label = 'replace' } = {}) {
  return commit(() => migrate(next), { label });
}

export function canUndo() {
  return undoStack.length > 0;
}

export function lastUndoLabel() {
  return undoStack[undoStack.length - 1]?.label ?? null;
}

export function undo() {
  const entry = undoStack.pop();
  if (!entry) return null;
  state = entry.state;
  persist();
  notify();
  return entry.label;
}

export function updateSettings(patch) {
  return commit((current) => ({ ...current, settings: { ...current.settings, ...patch } }), {
    label: 'settings',
  });
}

export function moneyOpts(current = state) {
  return { currency: current.settings.currency, locale: current.settings.locale };
}

export function hasData(current = state) {
  return current.accounts.length > 0 || current.transactions.length > 0;
}

export function clearAll() {
  return commit(() => emptyState(), { label: 'clear all data' });
}
