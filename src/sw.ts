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
 */

/// <reference lib="webworker" />

// `self` is typed as a generic WorkerGlobalScope in the webworker lib; a
// service worker's own scope adds clients, skipWaiting and the lifecycle events.
const sw = self as unknown as ServiceWorkerGlobalScope;

const VERSION = 'v1.0.0';
const SHELL_CACHE = `zenith-shell-${VERSION}`;
const RUNTIME_CACHE = `zenith-runtime-${VERSION}`;

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
  './dist/core/money.js',
  './dist/core/dates.js',
  './dist/core/model.js',
  './dist/core/budget.js',
  './dist/core/cards.js',
  './dist/core/actions.js',
  './dist/core/seed.js',
  './dist/ui/dom.js',
  './dist/ui/icons.js',
  './dist/ui/charts.js',
  './dist/ui/components.js',
  './dist/ui/modal.js',
  './dist/ui/toast.js',
  './dist/ui/forms.js',
  './dist/views/chart-data.js',
  './dist/views/dashboard.js',
  './dist/views/budget.js',
  './dist/views/cards.js',
  './dist/views/transactions.js',
  './dist/views/accounts.js',
  './dist/views/reports.js',
  './dist/views/settings.js',
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
          .filter((key) => key.startsWith('zenith-') && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
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
