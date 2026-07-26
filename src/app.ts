/** App shell: chrome, navigation, theme, and the render loop. */

import { h, mount, qs } from './ui/dom.ts';
import { icon } from './ui/icons.ts';
import { toast } from './ui/toast.ts';
import { openTransactionForm } from './ui/forms.ts';
import { currentMonth } from './core/dates.ts';
import { getState, subscribe, onPersistError, canUndo, undo, lastUndoLabel } from './store.ts';
import { defineRoutes, startRouter, getRoute } from './router.ts';
import type { ActiveRoute, RouteDefinition } from './router.ts';
import { initPwa, onPwaChange, installState, promptInstall } from './pwa.ts';
import type { IconName } from './ui/icons.ts';
import { isEmbedded } from './core/model.ts';
import type { ThemePreference } from './core/model.ts';

import { dashboardView } from './views/dashboard.ts';
import { budgetView } from './views/budget.ts';
import { cardsView, cardDetailView } from './views/cards.ts';
import { transactionsView } from './views/transactions.ts';
import { accountsView } from './views/accounts.ts';
import { reportsView } from './views/reports.ts';
import { settingsView } from './views/settings.ts';

interface NavItem {
  name: string;
  href: string;
  label: string;
  icon: IconName;
}

const NAV: NavItem[] = [
  { name: 'dashboard', href: '#/', label: 'Home', icon: 'dashboard' },
  { name: 'budget', href: '#/budget', label: 'Budget', icon: 'budget' },
  { name: 'cards', href: '#/cards', label: 'Cards', icon: 'card' },
  { name: 'transactions', href: '#/transactions', label: 'Ledger', icon: 'ledger' },
  { name: 'reports', href: '#/reports', label: 'Reports', icon: 'reports' },
];

const ROUTES: RouteDefinition[] = [
  { name: 'dashboard', pattern: [], view: () => dashboardView({ month: currentMonth() }) },
  { name: 'budget', pattern: ['budget'], view: () => budgetView({ month: currentMonth() }) },
  { name: 'budget', pattern: ['budget', ':month'], view: ({ month }) => budgetView({ month }) },
  { name: 'cards', pattern: ['cards'], view: () => cardsView({ month: currentMonth() }) },
  {
    name: 'cards',
    pattern: ['cards', ':cardId'],
    view: ({ cardId }) => cardDetailView({ cardId, month: currentMonth() }),
  },
  { name: 'accounts', pattern: ['accounts'], view: () => accountsView() },
  { name: 'transactions', pattern: ['transactions'], view: (params) => transactionsView(params) },
  { name: 'reports', pattern: ['reports'], view: () => reportsView() },
  { name: 'settings', pattern: ['settings'], view: () => settingsView() },
];

let appRoot: HTMLElement | null = null;
let viewHost: HTMLElement | null = null;
let lastPath: string | null = null;
const scrollPositions = new Map<string, number>();

export function start(): void {
  appRoot = qs('#app');
  if (!appRoot) throw new Error('Zenith could not find its #app mount point.');
  buildShell(appRoot);
  applyTheme(getState().settings.theme);

  defineRoutes(ROUTES);
  initPwa();

  onPersistError((message) => toast(message, { tone: 'error', duration: 8000 }));

  // A state change re-renders the current route in place, keeping scroll.
  subscribe(() => {
    applyTheme(getState().settings.theme);
    render(getRoute(), { keepScroll: true });
  });
  onPwaChange(() => renderChrome());

  startRouter((route) => render(route));

  document.addEventListener('keydown', (event) => {
    const inField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '');
    if (inField || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'n') {
      event.preventDefault();
      openTransactionForm();
    } else if (event.key === 'u' && canUndo()) {
      event.preventDefault();
      const label = undo();
      toast(`Undid ${label}.`, { tone: 'info' });
    }
  });
}

function buildShell(root: HTMLElement): void {
  const header = h('header.app-header');
  const nav = h('nav.app-nav', { 'aria-label': 'Main' });
  viewHost = h('main#main.app-main', { tabindex: '-1' });

  mount(root, header, viewHost, nav);
  renderChrome();
}

function renderChrome(): void {
  const header = qs('.app-header');
  const nav = qs('.app-nav');
  if (!header || !nav) return;
  const route = getRoute();
  const pwa = installState();

  mount(
    header,
    h(
      'a.brand',
      { href: '#/', 'aria-label': 'Zenith home' },
      h('span.brand-mark', null, icon('zenith', { size: 18 })),
      h('span.brand-name', { text: 'Zenith' }),
    ),
    h(
      'div.header-actions',
      null,
      !pwa.online
        ? h('span.chip.chip-offline', null, icon('info', { size: 14 }), h('span', { text: 'Offline' }))
        : null,
      pwa.canPrompt && !pwa.installed
        ? h(
            'button.btn.btn-sm',
            { type: 'button', onclick: () => promptInstall(), title: 'Install Zenith' },
            icon('install', { size: 15 }),
            h('span', { text: 'Install' }),
          )
        : null,
      canUndo()
        ? h(
            'button.icon-btn',
            {
              type: 'button',
              'aria-label': `Undo ${lastUndoLabel() ?? 'last change'}`,
              title: `Undo ${lastUndoLabel() ?? ''} (u)`,
              onclick: () => {
                const label = undo();
                toast(`Undid ${label}.`, { tone: 'info' });
              },
            },
            icon('undo', { size: 18 }),
          )
        : null,
      h(
        'a',
        {
          class: `icon-btn${route?.name === 'accounts' ? ' is-active' : ''}`,
          href: '#/accounts',
          'aria-label': 'Accounts',
          title: 'Accounts',
        },
        icon('wallet', { size: 18 }),
      ),
      h(
        'a',
        {
          class: `icon-btn${route?.name === 'settings' ? ' is-active' : ''}`,
          href: '#/settings',
          'aria-label': 'Settings',
          title: 'Settings',
        },
        icon('settings', { size: 18 }),
      ),
    ),
  );

  mount(
    nav,
    ...NAV.map((item) =>
      h(
        'a',
        {
          class: `nav-item${route?.name === item.name ? ' is-active' : ''}`,
          href: item.href,
          'aria-current': route?.name === item.name ? 'page' : null,
        },
        icon(item.icon, { size: 21 }),
        h('span.nav-label', { text: item.label }),
      ),
    ),
    h(
      'button.nav-fab',
      { type: 'button', 'aria-label': 'Add transaction', title: 'Add transaction (n)', onclick: () => openTransactionForm() },
      icon('plus', { size: 22 }),
    ),
  );
}

function render(route: ActiveRoute | null, { keepScroll = false }: { keepScroll?: boolean } = {}): void {
  if (!route || !viewHost) return;
  // Remember where the outgoing screen was scrolled to, so going back to it
  // (Ledger → a card → Ledger) lands where you left off.
  if (!keepScroll && lastPath && lastPath !== route.path) {
    scrollPositions.set(lastPath, window.scrollY);
  }
  const scrollY = keepScroll ? window.scrollY : scrollPositions.get(route.path) ?? 0;
  lastPath = route.path;

  let view: Node;
  try {
    view = route.route.view(route.params ?? {});
  } catch (error) {
    console.error('View failed to render', error);
    view = errorView(error);
  }

  mount(viewHost, view);
  renderChrome();

  requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'auto' }));

  const title = route.name === 'dashboard' ? 'Zenith' : `${capitalise(route.name)} · Zenith`;
  document.title = title;
}

function errorView(error: unknown): HTMLElement {
  return h(
    'div.view',
    null,
    h(
      'div',
      { class: 'callout callout-critical' },
      h('div.callout-icon', null, icon('alert', { size: 20 })),
      h(
        'div.callout-body',
        null,
        h('h3.callout-title', { text: 'Something went wrong rendering this screen' }),
        h('p.callout-text', { text: error instanceof Error ? error.message : 'Unknown error' }),
      ),
      h('a.btn', { href: '#/', text: 'Back to home' }),
    ),
  );
}

function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'light' || preference === 'dark') root.dataset.theme = preference;
  // Embedded, "match device" means matching the host page: clearing the
  // attribute here would undo the viewer's own theme toggle.
  else if (!isEmbedded()) delete root.dataset.theme;

  const meta = qs('meta[name="theme-color"]');
  if (meta) {
    const dark =
      preference === 'dark' ||
      (preference !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    meta.setAttribute('content', dark ? '#0d0d0d' : '#f9f9f7');
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
