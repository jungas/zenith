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

/** URL parameters, merged from the path pattern and the query string. */
export type RouteParams = Record<string, string>;

export interface RouteDefinition {
  name: string;
  /** Path segments; a `:name` segment captures into params. */
  pattern: string[];
  view: (params: RouteParams) => Node;
}

export interface ActiveRoute {
  name: string;
  path: string;
  params: RouteParams;
  route: RouteDefinition;
}

const routes: RouteDefinition[] = [];
let onChange: ((route: ActiveRoute) => void) | null = null;
let currentRoute: ActiveRoute | null = null;

export function defineRoutes(definitions: RouteDefinition[]): void {
  routes.length = 0;
  routes.push(...definitions);
}

export function startRouter(handler: (route: ActiveRoute) => void): void {
  onChange = handler;
  window.addEventListener('hashchange', resolve);
  resolve();
}

export function navigate(hash: string, { replace = false }: { replace?: boolean } = {}): void {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (window.location.hash === target) {
    resolve();
    return;
  }
  if (replace) window.history.replaceState(null, '', target);
  else window.location.hash = target;
  if (replace) resolve();
}

export function getRoute(): ActiveRoute | null {
  return currentRoute;
}

/** Merge query params into the current route without adding history entries. */
export function setQuery(patch: Record<string, string | null>): void {
  const { path, params } = parseHash(window.location.hash);
  const next: RouteParams = { ...params };
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === '') delete next[key];
    else next[key] = value;
  }
  const query = new URLSearchParams(next).toString();
  const hash = `#${path}${query ? `?${query}` : ''}`;
  window.history.replaceState(null, '', hash);
  if (currentRoute) currentRoute = { ...currentRoute, params: next };
}

function parseHash(raw: string): { path: string; params: RouteParams } {
  const hash = (raw || '').replace(/^#/, '') || '/';
  const [path, queryString = ''] = hash.split('?');
  const params = Object.fromEntries(new URLSearchParams(queryString));
  return { path: path || '/', params };
}

function resolve(): void {
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
  if (!fallback) return;
  currentRoute = { name: fallback.name, path: '/', params, route: fallback };
  onChange?.(currentRoute);
}

/** Patterns are arrays like ['cards', ':cardId']. */
function matchRoute(pattern: string[], segments: string[]): RouteParams | null {
  if (pattern.length !== segments.length) return null;
  const params: RouteParams = {};
  for (const [index, part] of pattern.entries()) {
    const segment = segments[index] ?? '';
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segment);
    else if (part !== segment) return null;
  }
  return params;
}
