/**
 * The store: one state object, localStorage persistence, a subscribe/notify
 * loop, and a one-level undo stack.
 *
 * localStorage rather than IndexedDB is a deliberate trade: the whole budget is
 * a few hundred KB of JSON, reads are synchronous (so rendering never has to
 * await), and export/import is a single `JSON.stringify`.
 */

import { emptyState, ensurePaymentCategories, SCHEMA_VERSION } from './core/model.ts';
import type { AppState, MoneyOptions, Settings } from './core/model.ts';

/** A state transition: takes the current state, returns the next one. */
export type Mutator = (state: AppState) => AppState;
export type Listener = (state: AppState) => void;

interface UndoEntry {
  state: AppState;
  label: string;
}

const STORAGE_KEY = 'zenith.state.v1';
const UNDO_LIMIT = 25;

const listeners = new Set<Listener>();
const undoStack: UndoEntry[] = [];
let state: AppState = load();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function load(): AppState {
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

function migrate(parsed: Partial<AppState>): AppState {
  const base = emptyState();
  const next: AppState = {
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
function persist(): void {
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

let errorHandler: ((message: string) => void) | null = null;

export function onPersistError(handler: (message: string) => void): void {
  errorHandler = handler;
}

function notifyError(message: string): void {
  errorHandler?.(message);
}

export function getState(): AppState {
  return state;
}

/** Subscribe to state changes; returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of [...listeners]) listener(state);
}

/** Apply a transition, pushing the previous state onto the undo stack. */
export function commit(
  mutator: Mutator,
  opts: { undoable?: boolean; label?: string } = {},
): AppState {
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
export function replaceState(next: AppState, { label = 'replace' }: { label?: string } = {}): AppState {
  return commit(() => migrate(next), { label });
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function lastUndoLabel(): string | null {
  return undoStack[undoStack.length - 1]?.label ?? null;
}

export function undo(): string | null {
  const entry = undoStack.pop();
  if (!entry) return null;
  state = entry.state;
  persist();
  notify();
  return entry.label;
}

export function updateSettings(patch: Partial<Settings>): AppState {
  return commit((current) => ({ ...current, settings: { ...current.settings, ...patch } }), {
    label: 'settings',
  });
}

/** The currency/locale pair to thread into formatting calls. */
export function moneyOpts(current: AppState = state): Required<Pick<MoneyOptions, 'currency' | 'locale'>> {
  return { currency: current.settings.currency, locale: current.settings.locale };
}

export function hasData(current: AppState = state): boolean {
  return current.accounts.length > 0 || current.transactions.length > 0;
}

export function clearAll(): AppState {
  return commit(() => emptyState(), { label: 'clear all data' });
}
