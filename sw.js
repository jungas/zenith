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

const VERSION = 'v1.0.0';
const SHELL_CACHE = `zenith-shell-${VERSION}`;
const RUNTIME_CACHE = `zenith-runtime-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/tokens.css',
  './styles/base.css',
  './styles/components.css',
  './styles/views.css',
  './src/app.js',
  './src/router.js',
  './src/store.js',
  './src/pwa.js',
  './src/core/money.js',
  './src/core/dates.js',
  './src/core/model.js',
  './src/core/budget.js',
  './src/core/cards.js',
  './src/core/actions.js',
  './src/core/seed.js',
  './src/ui/dom.js',
  './src/ui/icons.js',
  './src/ui/charts.js',
  './src/ui/components.js',
  './src/ui/modal.js',
  './src/ui/toast.js',
  './src/ui/forms.js',
  './src/views/chart-data.js',
  './src/views/dashboard.js',
  './src/views/budget.js',
  './src/views/cards.js',
  './src/views/transactions.js',
  './src/views/accounts.js',
  './src/views/reports.js',
  './src/views/settings.js',
  './assets/icons/favicon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/maskable-192.png',
  './assets/icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
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

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('zenith-') && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  event.respondWith(handleAsset(request));
});

async function handleNavigation(request) {
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

async function handleAsset(request) {
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

async function revalidate(request) {
  const response = await fetch(request);
  if (!response.ok) return;
  const cache = await caches.open(SHELL_CACHE);
  await cache.put(request, response);
}
