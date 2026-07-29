/**
 * Service worker.
 *
 * Strategy:
 *   · app shell (HTML, CSS, JS, icons) — cache-first, precached on install, so
 *     the app opens instantly and works with no network at all
 *   · navigations — network-first with a cache fallback to index.html, so an
 *     offline launch still boots the shell
 *   · everything else same-origin — stale-while-revalidate
 *
 * There is no network dependency for data: the budget lives in localStorage, so
 * "offline" is the normal case rather than a degraded one.
 *
 * It also delivers reminders while the app is closed — see the reminders
 * section below.
 */

/// <reference lib="webworker" />

// `self` is typed as a generic WorkerGlobalScope in the webworker lib; a
// service worker's own scope adds clients, skipWaiting and the lifecycle events.
const sw = self as unknown as ServiceWorkerGlobalScope;

/**
 * Stamped at build time by `tools/stamp-sw.ts` with a hash of the shell's
 * sources — this literal is what a dev build without that step runs with.
 *
 * The version is the cache-busting mechanism: it names both caches below, and
 * `activate` deletes every `zenith-` cache that is not one of them. A new
 * version therefore means a fresh precache and the old one thrown away.
 */
const VERSION = 'dev';
const SHELL_CACHE = `zenith-shell-${VERSION}`;
const RUNTIME_CACHE = `zenith-runtime-${VERSION}`;

/**
 * The reminder schedule the app writes for this worker. Deliberately *not*
 * versioned with the shell: it is data, not code, and must survive an update.
 */
const REMINDER_CACHE = 'zenith-reminders';
const REMINDER_KEY = './reminder-schedule.json';
const REMINDER_TAG = 'zenith-reminders';

const SHELL: string[] = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/tokens.css',
  './styles/base.css',
  './styles/components.css',
  './styles/views.css',
  './styles/glass.css',
  './dist/app.js',
  './dist/router.js',
  './dist/store.js',
  './dist/pwa.js',
  './dist/reminders.js',
  './dist/core/money.js',
  './dist/core/dates.js',
  './dist/core/model.js',
  './dist/core/budget.js',
  './dist/core/cards.js',
  './dist/core/installments.js',
  './dist/core/actions.js',
  './dist/core/reminders.js',
  './dist/core/seed.js',
  './dist/ui/dom.js',
  './dist/ui/icons.js',
  './dist/ui/charts.js',
  './dist/ui/components.js',
  './dist/ui/modal.js',
  './dist/ui/toast.js',
  './dist/ui/forms.js',
  './dist/ui/password.js',
  './dist/core/statement.js',
  './dist/core/statement-import.js',
  './dist/core/pdf/inflate.js',
  './dist/core/pdf/crypt.js',
  './dist/core/pdf/security.js',
  './dist/core/pdf/objects.js',
  './dist/core/pdf/filters.js',
  './dist/core/pdf/document.js',
  './dist/core/pdf/fonts.js',
  './dist/core/pdf/text.js',
  './dist/core/pdf/read.js',
  './dist/views/chart-data.js',
  './dist/views/dashboard.js',
  './dist/views/budget.js',
  './dist/views/cards.js',
  './dist/views/transactions.js',
  './dist/views/accounts.js',
  './dist/views/reports.js',
  './dist/views/settings.js',
  './dist/views/import.js',
  './assets/icons/favicon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/maskable-192.png',
  './assets/icons/maskable-512.png',
];

sw.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll rejects the whole batch if one entry 404s; add individually so a
      // single missing asset can never block the install.
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((error) => {
            console.warn('[sw] could not precache', url, error);
          }),
        ),
      );
    })(),
  );
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) =>
              key.startsWith('zenith-') &&
              key !== SHELL_CACHE &&
              key !== RUNTIME_CACHE &&
              key !== REMINDER_CACHE,
          )
          .map((key) => caches.delete(key)),
      );
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('message', (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void sw.skipWaiting();
});

sw.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  event.respondWith(handleAsset(request));
});

async function handleNavigation(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    cache.put('./index.html', response.clone());
    return response;
  } catch {
    const cached = (await caches.match('./index.html')) || (await caches.match('./'));
    return (
      cached ??
      new Response('<h1>Offline</h1><p>Zenith could not load its shell from the cache.</p>', {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    );
  }
}

async function handleAsset(request: Request): Promise<Response> {
  const cached = await caches.match(request);
  if (cached) {
    // Refresh in the background; the cached copy answers now.
    revalidate(request).catch(() => {});
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function revalidate(request: Request): Promise<void> {
  const response = await fetch(request);
  if (!response.ok) return;
  const cache = await caches.open(SHELL_CACHE);
  await cache.put(request, response);
}

/* ── Reminders ──────────────────────────────────────────────────────────────
 *
 * A worker cannot read localStorage, so it cannot recompute anything from the
 * budget. The app instead writes a precomputed schedule into the Cache API —
 * the one store both sides can reach — and all this worker does is compare
 * dates and show what is due. `delivered` is the shared receipt list that keeps
 * a reminder from arriving twice, whichever side raised it.
 *
 * The shapes below deliberately duplicate `core/reminders.ts` rather than
 * importing it: pulling an app module in here would drag the whole module tree
 * into the worker's own build output, which is emitted to the repo root.
 * `tests/pwa.test.ts` checks the two sides still agree on the cache entry.
 */

interface ScheduledReminder {
  id: string;
  fireOn: string;
  title: string;
  body: string;
  route: string;
  urgent?: boolean;
}

interface ReminderSchedule {
  version: number;
  updatedAt: string;
  reminders: ScheduledReminder[];
  delivered: string[];
}

/** Matches `REMINDER_GRACE_DAYS` in core/reminders.ts. */
const REMINDER_GRACE_DAYS = 2;
const REMINDER_MAX_PER_WAKE = 3;
const REMINDER_LOG_LIMIT = 200;

// 'periodicsync' is not in the TypeScript lib yet, so the event arrives as a
// plain Event and is narrowed here.
sw.addEventListener('periodicsync', (event: Event) => {
  const sync = event as ExtendableEvent & { tag?: string };
  if (sync.tag !== REMINDER_TAG) return;
  sync.waitUntil(deliverDueReminders());
});

sw.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const data = event.notification.data as { route?: string } | null;
  event.waitUntil(openApp(typeof data?.route === 'string' ? data.route : '#/'));
});

async function deliverDueReminders(): Promise<void> {
  const cache = await caches.open(REMINDER_CACHE);
  const stored = await cache.match(REMINDER_KEY);
  if (!stored) return;

  const schedule = (await stored.json()) as ReminderSchedule | null;
  if (!schedule || !Array.isArray(schedule.reminders)) return;

  const delivered = new Set(Array.isArray(schedule.delivered) ? schedule.delivered : []);
  const today = localDate();
  const shown: string[] = [];

  for (const reminder of schedule.reminders) {
    if (shown.length >= REMINDER_MAX_PER_WAKE) break;
    if (delivered.has(reminder.id)) continue;
    const offset = daysUntil(today, reminder.fireOn);
    // Not yet, or so late that saying it now is noise rather than a reminder.
    if (offset > 0 || offset < -REMINDER_GRACE_DAYS) continue;
    try {
      await sw.registration.showNotification(reminder.title, {
        body: reminder.body,
        tag: reminder.id,
        icon: './assets/icons/icon-192.png',
        badge: './assets/icons/icon-192.png',
        data: { route: reminder.route },
        requireInteraction: reminder.urgent === true,
      });
      shown.push(reminder.id);
    } catch (error) {
      // Permission revoked since the schedule was written; stop trying.
      console.warn('[sw] could not show a reminder', error);
      return;
    }
  }

  if (!shown.length) return;
  const next: ReminderSchedule = {
    ...schedule,
    delivered: [...delivered, ...shown].slice(-REMINDER_LOG_LIMIT),
  };
  await cache.put(
    REMINDER_KEY,
    new Response(JSON.stringify(next), { headers: { 'Content-Type': 'application/json' } }),
  );
}

/** Focus the app if it is already open, otherwise launch it, at `route`. */
async function openApp(route: string): Promise<void> {
  const target = new URL(`./index.html${route}`, sw.location.href);
  const clients = (await sw.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })) as readonly WindowClient[];

  for (const client of clients) {
    if (new URL(client.url).origin !== target.origin) continue;
    await client.focus();
    // Same document, different hash: navigate rather than open a second window.
    await client.navigate(target.href).catch(() => {});
    return;
  }
  await sw.clients.openWindow(target.href);
}

/** Today in the device's own timezone, as 'YYYY-MM-DD'. */
function localDate(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whole days from `from` to `to`; negative when `to` has already passed. */
function daysUntil(from: string, to: string): number {
  const midnight = (iso: string): number => {
    const [year = 1970, month = 1, day = 1] = String(iso).split('-').map(Number);
    return new Date(year, month - 1, day).getTime();
  };
  return Math.round((midnight(to) - midnight(from)) / 86_400_000);
}
