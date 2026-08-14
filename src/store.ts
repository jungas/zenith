/**
 * The store: one state object, a subscribe/notify loop, and a one-level undo
 * stack — persisted to whichever backend this build is wired for.
 *
 * Two backends share this file:
 *
 *   · **server** — set when `window.__ZENITH_BACKEND__ === 'server'`. State
 *     loads from and saves to `/api/state` on Zenith's own server (`server/`),
 *     which is the durable copy; there is no offline queue, so a save that
 *     cannot reach the server is reported as failed, not silently deferred.
 *   · **local** — the default when that flag is absent: `localStorage`,
 *     synchronous, no network.
 *
 * The checked-in `index.html` never sets the flag itself — it stays
 * backend-neutral so a plain static host (GitHub Pages, a double-clicked
 * `file://`) or the single-file `build:artifact` output falls back to
 * `localStorage` with no server to talk to. Zenith's own server
 * (`server/static.ts`) injects the flag into `<head>` when *it* serves
 * `index.html`, which is the only case that should use it.
 *
 * The public API — `getState`, `commit`, `subscribe`, `undo`, … — is
 * identical either way; callers never branch on backend.
 */

import { emptyState, ensurePaymentCategories, SCHEMA_VERSION } from './core/model.ts';
import { tidySharedLimits } from './core/actions.ts';
import type { AppState, MoneyOptions, Settings } from './core/model.ts';

declare global {
  interface Window {
    /**
     * Injected by `server/static.ts` into `index.html` when Zenith's own
     * server serves it — see the file header. Absent everywhere else, which
     * is what makes `localStorage` the safe default.
     */
    __ZENITH_BACKEND__?: 'server';
  }
}

/** A state transition: takes the current state, returns the next one. */
export type Mutator = (state: AppState) => AppState;
export type Listener = (state: AppState) => void;

interface UndoEntry {
  state: AppState;
  label: string;
}

const STORAGE_KEY = 'zenith.state.v1';
const UNDO_LIMIT = 25;
const SAVE_RETRY_MS = 5000;

const BACKEND: 'local' | 'server' =
  typeof window !== 'undefined' && window.__ZENITH_BACKEND__ === 'server' ? 'server' : 'local';

const listeners = new Set<Listener>();
const undoStack: UndoEntry[] = [];

// The server backend has nothing to show until `init()` resolves; the local
// backend loads synchronously, same as before there was a server at all.
let state: AppState = BACKEND === 'server' ? emptyState() : loadLocal();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

// Server backend only.
let serverVersion = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let saveConflict = false;

function loadLocal(): AppState {
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
    settings: {
      ...base.settings,
      ...(parsed.settings || {}),
      // Nested, so a spread alone would replace the defaults wholesale — a
      // backup taken before reminders existed would land with none of them.
      reminders: { ...base.settings.reminders, ...(parsed.settings?.reminders || {}) },
    },
    accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
    categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
    budgets: parsed.budgets && typeof parsed.budgets === 'object' ? parsed.budgets : {},
    sharedLimits: Array.isArray(parsed.sharedLimits) ? parsed.sharedLimits : [],
    installments: Array.isArray(parsed.installments) ? parsed.installments : [],
    bills: Array.isArray(parsed.bills) ? parsed.bills : [],
  };
  return tidySharedLimits(ensurePaymentCategories(next));
}

/**
 * For the server backend: fetch the current state before the app renders
 * anything. Throws on failure — the caller (`index.html`'s bootstrap script)
 * is expected to show an error screen rather than start the app on a blank
 * slate that would then autosave over whatever is really on the server.
 *
 * A no-op for the local backend, which already loaded synchronously above.
 */
export async function init(): Promise<void> {
  if (BACKEND !== 'server') return;
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error(`Could not load Zenith's data (server said ${response.status}).`);
  const body = (await response.json()) as { version: number; data: Partial<AppState> | null };
  serverVersion = body.version;
  state = migrate(body.data ?? {});
}

/**
 * Is browser storage usable at all? A sandboxed frame can deny it outright,
 * which is a different problem from a full disk and deserves a different
 * message. Local backend only.
 */
function storageWorks(): boolean {
  try {
    const probe = '__zenith_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

let warnedAboutStorage = false;

function persistLocal(): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    // Report once. Repeating it on every keystroke would bury the app in
    // toasts for a condition the user cannot fix mid-session.
    if (warnedAboutStorage) return;
    warnedAboutStorage = true;
    console.error('Saving failed.', error);
    notifyError(
      storageWorks()
        ? 'Could not save. Your device storage may be full.'
        : 'This browser is blocking storage here, so changes will be lost when you close the page.',
    );
  }
}

let warnedAboutSave = false;

/**
 * PUTs the whole state to `/api/state` under the version it was last loaded
 * or saved at. A 409 means somewhere else — another tab, another device —
 * saved since; autosaving is stopped rather than guessed at, because a
 * last-write-wins retry here could silently erase that other save.
 */
async function persistServer(): Promise<void> {
  if (saveConflict) return;
  try {
    const response = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: serverVersion, data: state }),
    });

    if (response.status === 409) {
      saveConflict = true;
      const body = await response.json().catch(() => null);
      notifyError(
        (body as { error?: string } | null)?.error ??
          'This budget changed elsewhere. Reload to see the latest — your last change here was not saved.',
      );
      return;
    }
    if (!response.ok) throw new Error(`save failed with status ${response.status}`);

    const body = (await response.json()) as { version: number };
    serverVersion = body.version;
    warnedAboutSave = false;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  } catch (error) {
    console.error('Saving failed.', error);
    if (!warnedAboutSave) {
      warnedAboutSave = true;
      notifyError('Could not reach the server — this change was not saved yet. Retrying…');
    }
    if (!retryTimer) retryTimer = setTimeout(() => void persistServer(), SAVE_RETRY_MS);
  }
}

/** True while a change is made but not yet confirmed saved. */
export function hasUnsavedChanges(): boolean {
  return persistTimer !== null || retryTimer !== null;
}

if (BACKEND === 'server' && typeof window !== 'undefined') {
  // Losing an edit is worse than an unwanted prompt: warn before closing the
  // tab while a save is still pending or retrying.
  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

/** Writes are debounced — a slider drag shouldn't hit disk 60 times a second. */
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (BACKEND === 'local') persistLocal();
    else void persistServer();
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

/** Which persistence backend this build is wired for — see the file header. */
export function backend(): 'local' | 'server' {
  return BACKEND;
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
  schedulePersist();
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
  schedulePersist();
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
