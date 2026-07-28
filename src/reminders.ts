/**
 * Notification delivery.
 *
 * Zenith has no server, so there is nothing to push *from*: these are real
 * system notifications, but they are generated on this device from the budget
 * in `core/reminders.ts` rather than sent over the network. Two things raise
 * them:
 *
 *   · this module, whenever the app is open — on launch, when the tab becomes
 *     visible again, and on a quarter-hour tick
 *   · the service worker, when the browser wakes it for periodic background
 *     sync (installed PWAs on Chromium; elsewhere the app has to be opened)
 *
 * The worker cannot read localStorage, so it cannot recompute anything. Instead
 * the app writes a precomputed schedule into the Cache API — the one store both
 * sides can reach — and the worker only has to compare dates. `delivered` is
 * the shared receipt list that keeps a reminder from arriving twice, whichever
 * side showed it.
 */

import { dueReminders, plannedReminders, reminderSettings } from './core/reminders.ts';
import type { Reminder } from './core/reminders.ts';
import { isEmbedded } from './core/model.ts';
import type { AppState, ReminderSettings } from './core/model.ts';
import { getState, subscribe, updateSettings } from './store.ts';

/** Kept in step with `src/sw.ts`, which reads the same entry. */
const SCHEDULE_CACHE = 'zenith-reminders';
const SCHEDULE_KEY = './reminder-schedule.json';
const PERIODIC_TAG = 'zenith-reminders';

const DELIVERED_KEY = 'zenith.reminders.delivered.v1';
const DELIVERED_LIMIT = 200;
const TICK_MS = 15 * 60 * 1000;
/** Twelve hours: the browser treats it as a floor, not a promise. */
const PERIODIC_INTERVAL_MS = 12 * 60 * 60 * 1000;
/**
 * A quiet cap. Three cards each with a payment and an unfunded warning is six
 * system notifications at once, which reads as spam however true it is; the
 * rest wait for the next tick.
 */
const MAX_PER_TICK = 3;

/** The schedule document shared with the service worker. */
interface ReminderSchedule {
  version: number;
  updatedAt: string;
  reminders: Reminder[];
  delivered: string[];
}

interface NotifyOptions {
  tag: string;
  route: string;
  urgent?: boolean;
}

interface PeriodicSyncManager {
  register: (tag: string, options?: { minInterval?: number }) => Promise<void>;
  getTags: () => Promise<string[]>;
}

/** Notifications are a browser API the single-file build has no worker for. */
export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined' && !isEmbedded();
}

export function notificationPermission(): NotificationPermission {
  return notificationsSupported() ? Notification.permission : 'denied';
}

/**
 * Can reminders arrive while Zenith is closed? Only where the browser offers
 * periodic background sync — everywhere else they wait for the app to open,
 * which is worth saying plainly rather than letting people wonder.
 */
export function backgroundDeliverySupported(): boolean {
  return (
    typeof ServiceWorkerRegistration !== 'undefined' &&
    'periodicSync' in ServiceWorkerRegistration.prototype
  );
}

export function remindersOn(state: AppState = getState()): boolean {
  return reminderSettings(state).enabled && notificationPermission() === 'granted';
}

export function setReminderSettings(patch: Partial<ReminderSettings>): void {
  updateSettings({ reminders: { ...reminderSettings(getState()), ...patch } });
}

/**
 * Turn reminders on, asking for permission first. Returns the permission that
 * resulted, so the caller can say something useful about a refusal.
 */
export async function enableReminders(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return 'denied';
  let result = Notification.permission;
  if (result === 'default') result = await Notification.requestPermission();
  if (result !== 'granted') return result;

  setReminderSettings({ enabled: true });
  await syncSchedule();
  await registerPeriodicSync();
  await tick();
  return result;
}

/** Turn them off, and leave nothing behind that could still fire. */
export async function disableReminders(): Promise<void> {
  setReminderSettings({ enabled: false });
  await syncSchedule();
  await unregisterPeriodicSync();
  await closeShownNotifications();
}

export async function sendTestNotification(): Promise<boolean> {
  if (notificationPermission() !== 'granted') return false;
  return notify('Zenith reminders are on', 'This is how a payment reminder will look.', {
    tag: 'zenith-test',
    route: '#/cards',
  });
}

/** Start the loops. Safe to call where notifications do not exist. */
export function initReminders(): void {
  if (!notificationsSupported()) return;

  let pending: ReturnType<typeof setTimeout> | null = null;
  subscribe(() => {
    // Any edit can move a reminder — paying a card removes one, a new charge
    // adds one — so the worker's copy is rewritten after the dust settles.
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      void syncSchedule();
    }, 500);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void tick();
  });

  setInterval(() => void tick(), TICK_MS);

  void (async () => {
    await syncSchedule();
    await registerPeriodicSync();
    await tick();
  })();
}

/**
 * Hand the worker the current schedule. Written even when reminders are off —
 * an empty schedule is what stops a background wake firing yesterday's news.
 *
 * Reads before it writes: the worker may have delivered something while the app
 * was closed, and those receipts are only in the shared document. Overwriting
 * them with this device's older log would show that reminder a second time.
 */
export async function syncSchedule(): Promise<void> {
  const stored = await readSchedule();
  if (stored?.delivered?.length) rememberDelivered(stored.delivered);

  const state = getState();
  await writeSchedule({
    version: 1,
    updatedAt: new Date().toISOString(),
    reminders: remindersOn(state) ? plannedReminders(state) : [],
    delivered: [...deliveredLog()],
  });
}

/** Show whatever is due now, and record it. */
export async function tick(): Promise<void> {
  if (!remindersOn()) return;

  // Brings the worker's receipts across before anything is decided, so a
  // reminder it already showed is not shown again here.
  await syncSchedule();

  const pending = dueReminders(getState(), { delivered: deliveredLog() });
  if (!pending.length) return;

  const shown: string[] = [];
  for (const reminder of pending.slice(0, MAX_PER_TICK)) {
    const ok = await notify(reminder.title, reminder.body, {
      tag: reminder.id,
      route: reminder.route,
      urgent: reminder.urgent,
    });
    if (ok) shown.push(reminder.id);
  }

  if (!shown.length) return;
  rememberDelivered(shown);
  await syncSchedule();
}

/**
 * Raise one notification. Through the service worker where there is one: a
 * worker notification survives the tab closing, and is the only kind Android
 * shows at all.
 */
async function notify(title: string, body: string, { tag, route, urgent = false }: NotifyOptions): Promise<boolean> {
  const options: NotificationOptions = {
    body,
    tag,
    icon: './assets/icons/icon-192.png',
    badge: './assets/icons/icon-192.png',
    data: { route },
    requireInteraction: urgent,
  };
  try {
    const registration = await workerRegistration();
    if (registration) {
      await registration.showNotification(title, options);
      return true;
    }
    new Notification(title, options);
    return true;
  } catch (error) {
    console.warn('Could not show a reminder.', error);
    return false;
  }
}

async function workerRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  try {
    return await navigator.serviceWorker.getRegistration();
  } catch {
    return undefined;
  }
}

async function closeShownNotifications(): Promise<void> {
  const registration = await workerRegistration();
  if (!registration) return;
  try {
    for (const notification of await registration.getNotifications()) notification.close();
  } catch {
    // Nothing to close, or the browser will not enumerate them.
  }
}

/* Background wake-ups. Unsupported and blocked are the same outcome here — the
 * app falls back to firing on open — so neither is worth a message. */

async function periodicSync(): Promise<PeriodicSyncManager | undefined> {
  const registration = await workerRegistration();
  return (registration as (ServiceWorkerRegistration & { periodicSync?: PeriodicSyncManager }) | undefined)
    ?.periodicSync;
}

async function registerPeriodicSync(): Promise<void> {
  try {
    const sync = await periodicSync();
    if (!sync) return;
    const status = await navigator.permissions?.query({
      name: 'periodic-background-sync' as PermissionName,
    });
    if (status && status.state !== 'granted') return;
    await sync.register(PERIODIC_TAG, { minInterval: PERIODIC_INTERVAL_MS });
  } catch {
    // Chromium only, and only for installed apps.
  }
}

async function unregisterPeriodicSync(): Promise<void> {
  try {
    const sync = await periodicSync();
    await (sync as (PeriodicSyncManager & { unregister?: (tag: string) => Promise<void> }) | undefined)
      ?.unregister?.(PERIODIC_TAG);
  } catch {
    // Never registered, or already gone.
  }
}

/* The delivered log. Device-local rather than part of the budget: which
 * notifications this phone has seen is not something to carry into a backup. */

function deliveredLog(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(DELIVERED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function rememberDelivered(ids: Iterable<string>): void {
  const merged = [...deliveredLog(), ...ids];
  try {
    globalThis.localStorage?.setItem(
      DELIVERED_KEY,
      JSON.stringify([...new Set(merged)].slice(-DELIVERED_LIMIT)),
    );
  } catch {
    // Storage denied: reminders may repeat, which beats not arriving.
  }
}

/* The schedule, in the one store both the page and the worker can reach. */

async function readSchedule(): Promise<ReminderSchedule | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(SCHEDULE_CACHE);
    const stored = await cache.match(SCHEDULE_KEY);
    return stored ? ((await stored.json()) as ReminderSchedule) : null;
  } catch {
    return null;
  }
}

async function writeSchedule(schedule: ReminderSchedule): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(SCHEDULE_CACHE);
    await cache.put(
      SCHEDULE_KEY,
      new Response(JSON.stringify(schedule), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  } catch (error) {
    console.warn('Could not hand the reminder schedule to the service worker.', error);
  }
}
