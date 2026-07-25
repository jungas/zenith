/**
 * Hash routing. Hashes rather than the History API so the app works from a
 * file:// URL or any static host with no server-side rewrite rules.
 *
 * Routes:
 *   #/                     dashboard (current month)
 *   #/budget[/YYYY-MM]     budget for a month
 *   #/cards                card list
 *   #/cards/:id            one card, with payoff planner
 *   #/accounts             accounts
 *   #/transactions?…       ledger with filters
 *   #/reports              reports
 *   #/settings             settings
 */

const routes = [];
let onChange = null;
let currentRoute = null;

export function defineRoutes(definitions) {
  routes.length = 0;
  routes.push(...definitions);
}

export function startRouter(handler) {
  onChange = handler;
  window.addEventListener('hashchange', resolve);
  resolve();
}

export function navigate(hash, { replace = false } = {}) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (window.location.hash === target) {
    resolve();
    return;
  }
  if (replace) window.history.replaceState(null, '', target);
  else window.location.hash = target;
  if (replace) resolve();
}

export function getRoute() {
  return currentRoute;
}

/** Merge query params into the current route without adding history entries. */
export function setQuery(patch) {
  const { path, params } = parseHash(window.location.hash);
  const next = { ...params };
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === '') delete next[key];
    else next[key] = value;
  }
  const query = new URLSearchParams(next).toString();
  const hash = `#${path}${query ? `?${query}` : ''}`;
  window.history.replaceState(null, '', hash);
  currentRoute = { ...currentRoute, params: next };
}

function parseHash(raw) {
  const hash = (raw || '').replace(/^#/, '') || '/';
  const [path, queryString = ''] = hash.split('?');
  const params = Object.fromEntries(new URLSearchParams(queryString));
  return { path: path || '/', params };
}

function resolve() {
  const { path, params } = parseHash(window.location.hash);
  const segments = path.split('/').filter(Boolean);

  for (const route of routes) {
    const match = matchRoute(route.pattern, segments);
    if (!match) continue;
    currentRoute = { name: route.name, path, params: { ...params, ...match }, route };
    onChange?.(currentRoute);
    return;
  }

  const fallback = routes[0];
  currentRoute = { name: fallback.name, path: '/', params, route: fallback };
  onChange?.(currentRoute);
}

/** Patterns are arrays like ['cards', ':cardId']. */
function matchRoute(pattern, segments) {
  if (pattern.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i++) {
    const part = pattern[i];
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segments[i]);
    else if (part !== segments[i]) return null;
  }
  return params;
}
