/** App shell: chrome, navigation, theme, and the render loop. */

import { h, mount, qs } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { openTransactionForm } from './ui/forms.js';
import { currentMonth } from './core/dates.js';
import { getState, subscribe, onPersistError, canUndo, undo, lastUndoLabel } from './store.js';
import { defineRoutes, startRouter, getRoute } from './router.js';
import { initPwa, onPwaChange, installState, promptInstall } from './pwa.js';

import { dashboardView } from './views/dashboard.js';
import { budgetView } from './views/budget.js';
import { cardsView, cardDetailView } from './views/cards.js';
import { transactionsView } from './views/transactions.js';
import { accountsView } from './views/accounts.js';
import { reportsView } from './views/reports.js';
import { settingsView } from './views/settings.js';

const NAV = [
  { name: 'dashboard', href: '#/', label: 'Home', icon: 'dashboard' },
  { name: 'budget', href: '#/budget', label: 'Budget', icon: 'budget' },
  { name: 'cards', href: '#/cards', label: 'Cards', icon: 'card' },
  { name: 'transactions', href: '#/transactions', label: 'Ledger', icon: 'ledger' },
  { name: 'reports', href: '#/reports', label: 'Reports', icon: 'reports' },
];

const ROUTES = [
  { name: 'dashboard', pattern: [], view: () => dashboardView({ month: currentMonth() }) },
  { name: 'budget', pattern: ['budget'], view: () => budgetView({ month: currentMonth() }) },
  { name: 'budget', pattern: ['budget', ':month'], view: ({ month }) => budgetView({ month }) },
  { name: 'cards', pattern: ['cards'], view: () => cardsView({ month: currentMonth() }) },
  { name: 'cards', pattern: ['cards', ':cardId'], view: ({ cardId }) => cardDetailView({ cardId, month: currentMonth() }) },
  { name: 'accounts', pattern: ['accounts'], view: () => accountsView() },
  { name: 'transactions', pattern: ['transactions'], view: (params) => transactionsView(params) },
  { name: 'reports', pattern: ['reports'], view: () => reportsView() },
  { name: 'settings', pattern: ['settings'], view: () => settingsView() },
];

let appRoot = null;
let viewHost = null;
let lastPath = null;
const scrollPositions = new Map();

export function start() {
  appRoot = qs('#app');
  buildShell();
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
    const inField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
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

function buildShell() {
  const header = h('header.app-header');
  const nav = h('nav.app-nav', { 'aria-label': 'Main' });
  viewHost = h('main#main.app-main', { tabindex: '-1' });

  mount(
    appRoot,
    header,
    viewHost,
    nav,
  );
  renderChrome();
}

function renderChrome() {
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
      h('span.brand-mark', null, icon('spark', { size: 18 })),
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

function render(route, { keepScroll = false } = {}) {
  if (!route || !viewHost) return;
  // Remember where the outgoing screen was scrolled to, so going back to it
  // (Ledger → a card → Ledger) lands where you left off.
  if (!keepScroll && lastPath && lastPath !== route.path) {
    scrollPositions.set(lastPath, window.scrollY);
  }
  const scrollY = keepScroll ? window.scrollY : scrollPositions.get(route.path) ?? 0;
  lastPath = route.path;

  let view;
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

function errorView(error) {
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
        h('p.callout-text', { text: error?.message ?? 'Unknown error' }),
      ),
      h('a.btn', { href: '#/', text: 'Back to home' }),
    ),
  );
}

function applyTheme(preference) {
  const root = document.documentElement;
  if (preference === 'light' || preference === 'dark') root.dataset.theme = preference;
  else delete root.dataset.theme;

  const meta = qs('meta[name="theme-color"]');
  if (meta) {
    const dark =
      preference === 'dark' ||
      (preference !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    meta.setAttribute('content', dark ? '#0d0d0d' : '#f9f9f7');
  }
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
