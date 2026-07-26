/** Settings — preferences, data portability, and a budget integrity check. */

import { h, append } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { sectionHeader, statusPill, field, select, input } from '../ui/components.ts';
import { confirmDialog } from '../ui/modal.ts';
import { toast } from '../ui/toast.ts';
import { formatMoney, formatPercent } from '../core/money.ts';
import { currentMonth } from '../core/dates.ts';
import { reconcile } from '../core/budget.ts';
import { seedState } from '../core/seed.ts';
import * as actions from '../core/actions.ts';
import {
  clearAll, getState, moneyOpts, replaceState, updateSettings, commit,
} from '../store.ts';
import { installState, promptInstall } from '../pwa.ts';
import { isEmbedded } from '../core/model.ts';
import type { Cents, MoneyOptions, ThemePreference } from '../core/model.ts';

// Alphabetical after the majors, so the list stays scannable as it grows.
const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'DKK', 'HKD', 'IDR',
  'INR', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'SEK', 'SGD',
  'THB', 'TWD', 'VND', 'ZAR',
];
const LOCALES = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'en-AU', label: 'English (Australia)' },
  { value: 'en-CA', label: 'English (Canada)' },
  { value: 'en-PH', label: 'English (Philippines)' },
  { value: 'fil-PH', label: 'Filipino' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'es-ES', label: 'Español' },
  { value: 'nl-NL', label: 'Nederlands' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'ja-JP', label: '日本語' },
];
const THEMES: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'Match device' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function settingsView(): HTMLElement {
  const state = getState();
  const money = moneyOpts(state);
  const root = h('div.view.view-settings');

  append(root, sectionHeader('Settings', { subtitle: 'Everything is stored on this device only' }));

  /* Preferences. */
  append(
    root,
    h(
      'section.card.block',
      null,
      h('h3.card-title', { text: 'Preferences' }),
      h(
        'div.form-grid',
        null,
        field(
          'Currency',
          select(
            CURRENCIES.map((code) => ({ value: code, label: code, selected: code === state.settings.currency })),
            { onchange: (event: Event) => updateSettings({ currency: (event.target as HTMLSelectElement).value }) },
          ),
          { id: 'set-currency' },
        ),
        field(
          'Number and date format',
          select(
            LOCALES.map((l) => ({ ...l, selected: l.value === state.settings.locale })),
            { onchange: (event: Event) => updateSettings({ locale: (event.target as HTMLSelectElement).value }) },
          ),
          { id: 'set-locale' },
        ),
      ),
      h(
        'div.form-grid',
        null,
        field(
          'Appearance',
          select(
            THEMES.map((t) => ({ ...t, selected: t.value === state.settings.theme })),
            {
              onchange: (event: Event) =>
                updateSettings({ theme: (event.target as HTMLSelectElement).value as ThemePreference }),
            },
          ),
          { id: 'set-theme' },
        ),
        field(
          'Warn above card utilisation',
          input({
            type: 'number',
            min: '5',
            max: '100',
            step: '5',
            value: Math.round((state.settings.utilizationWarn ?? 0.3) * 100),
            onchange: (event: Event) => {
              const pct = Math.min(100, Math.max(5, Number((event.target as HTMLInputElement).value) || 30));
              updateSettings({ utilizationWarn: pct / 100 });
            },
          }),
          { id: 'set-util', hint: 'Credit scoring generally favours staying under 30%.' },
        ),
      ),
    ),
  );

  /* Install. */
  const install = installState();
  append(
    root,
    h(
      'section.card.block',
      null,
      h('h3.card-title', { text: 'Install' }),
      isEmbedded()
        ? h(
            'div',
            null,
            h('p.card-text', {
              text: 'This is the single-file preview of Zenith. It works fully, and your budget is saved in this browser, but it cannot be installed or run offline — both need the service worker that only the full app ships with.',
            }),
            h('p.muted-note', null, icon('info', { size: 15 }), h('span', {
              text: 'Export a backup here and import it into the full app to carry your budget across.',
            })),
          )
        : install.installed
        ? h('p.card-text', null, statusPill('good', 'Installed', { size: 'sm' }), h('span', { text: 'Zenith is running as an installed app.' }))
        : h(
            'div',
            null,
            h('p.card-text', {
              text: 'Install Zenith to launch it from your home screen and use it fully offline.',
            }),
            install.canPrompt
              ? h(
                  'button.btn.btn-primary',
                  { type: 'button', onclick: () => promptInstall() },
                  icon('install', { size: 16 }),
                  h('span', { text: 'Install app' }),
                )
              : h('p.muted-note', null, icon('info', { size: 15 }), h('span', {
                  text: 'Use your browser menu — “Install app”, or “Add to Home Screen” on iOS.',
                })),
          ),
    ),
  );

  /* Data. */
  const fileInput = h<HTMLInputElement>('input', {
    type: 'file',
    accept: 'application/json,.json',
    style: { display: 'none' },
    onchange: async (event: Event) => {
      const target = event.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const next = actions.fromBackup(text);
        const ok = await confirmDialog({
          title: 'Replace your data?',
          message: `This backup has ${next.accounts.length} accounts and ${next.transactions.length} transactions. It will replace what is on this device.`,
          confirmLabel: 'Import',
          danger: true,
        });
        if (!ok) return;
        replaceState(next, { label: 'import' });
        toast('Backup imported.', { tone: 'success' });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        toast(message || 'That file could not be read.', { tone: 'error' });
      } finally {
        target.value = '';
      }
    },
  });

  append(
    root,
    h(
      'section.card.block',
      null,
      h('h3.card-title', { text: 'Your data' }),
      h('p.card-text', {
        text: 'Zenith keeps everything in this browser — nothing is uploaded. Export regularly so a cleared browser does not take your budget with it.',
      }),
      h(
        'div.button-row',
        null,
        h(
          'button.btn',
          { type: 'button', onclick: () => download(`zenith-backup-${todayStamp()}.json`, actions.toBackup(getState()), 'application/json') },
          icon('download', { size: 16 }),
          h('span', { text: 'Export backup (JSON)' }),
        ),
        h(
          'button.btn',
          { type: 'button', onclick: () => download(`zenith-transactions-${todayStamp()}.csv`, actions.toCsv(getState()), 'text/csv') },
          icon('ledger', { size: 16 }),
          h('span', { text: 'Export transactions (CSV)' }),
        ),
        h(
          'button.btn',
          { type: 'button', onclick: () => fileInput.click() },
          icon('upload', { size: 16 }),
          h('span', { text: 'Import backup' }),
        ),
        fileInput,
      ),
      h('div.divider'),
      h(
        'div.button-row',
        null,
        h(
          'button.btn',
          {
            type: 'button',
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Load sample data?',
                message: 'This replaces anything currently in the app with a worked example — four months of budgeting across two credit cards.',
                confirmLabel: 'Load sample',
              });
              if (!ok) return;
              replaceState(seedState(), { label: 'sample data' });
              toast('Sample budget loaded.', { tone: 'success' });
            },
          },
          icon('spark', { size: 16 }),
          h('span', { text: 'Load sample data' }),
        ),
        h(
          'button.btn.btn-danger-ghost',
          {
            type: 'button',
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Delete everything?',
                message: 'Every account, category and transaction on this device will be removed. Export a backup first if you might want it back.',
                confirmLabel: 'Delete everything',
                danger: true,
              });
              if (!ok) return;
              clearAll();
              toast('All data cleared.', { tone: 'info' });
            },
          },
          icon('trash', { size: 16 }),
          h('span', { text: 'Delete all data' }),
        ),
      ),
    ),
  );

  /* Integrity check — proves the card/budget wiring adds up. */
  const check = reconcile(state, currentMonth());
  append(
    root,
    h(
      'section.card.block',
      null,
      h('h3.card-title', { text: 'Budget integrity' }),
      h('p.card-text', {
        text: 'Unassigned cash plus everything sitting in envelopes should always equal the cash your accounts actually hold — card reserves included, because each one is backed by real money. This check runs that identity live.',
      }),
      h(
        'ul.integrity-list',
        { role: 'list' },
        integrityRow('Ready to assign', check.readyToAssign, money),
        integrityRow('Available across envelopes', check.available, money),
        integrityRow('…of which reserved for cards', check.cardReserves, money),
        integrityRow('Should equal cash in accounts', check.cash, money, true),
      ),
      check.debt > 0
        ? h('p.muted-note', null, icon('info', { size: 15 }), h('span', {
            text: `${formatMoney(check.debt, money)} of card debt sits outside this identity — reserves cancel the debt they created, so only debt that predates the budget shows up as unfunded.`,
          }))
        : null,
      check.balanced
        ? h('p.card-text', null, statusPill('good', 'Balanced'), h('span', { text: 'Every figure reconciles.' }))
        : h(
            'p.card-text',
            null,
            statusPill('critical', 'Out by ' + formatMoney(check.difference, money)),
            h('span', { text: 'This is a bug — please export your data before making further changes.' }),
          ),
    ),
  );

  /* Category admin. */
  append(
    root,
    h(
      'section.card.block',
      null,
      h('h3.card-title', { text: 'Categories' }),
      h(
        'ul.mini-list',
        { role: 'list' },
        state.categories
          .filter((c) => c.kind === 'spending')
          .map((category) =>
            h(
              'li.mini-row',
              null,
              h('span.row-swatch', { style: { background: `var(--${category.color})` } }),
              h('span.mini-name', { text: category.name }),
              h('span.mini-meta', { text: category.group }),
              h('button.icon-btn', {
                type: 'button',
                'aria-label': `Archive ${category.name}`,
                title: category.archived ? 'Restore' : 'Archive',
                onclick: () =>
                  commit((s) => actions.updateCategory(s, category.id, { archived: !category.archived }), {
                    label: 'archive category',
                  }),
              }, icon(category.archived ? 'undo' : 'trash', { size: 15 })),
            ),
          ),
      ),
      state.categories.filter((c) => c.kind === 'ccPayment').length
        ? h(
            'p.muted-note',
            null,
            icon('link', { size: 15 }),
            h('span', {
              text: `${state.categories.filter((c) => c.kind === 'ccPayment').length} card payment envelope(s) are managed automatically with their cards.`,
            }),
          )
        : null,
    ),
  );

  /* About. */
  append(
    root,
    h(
      'section.card.block',
      null,
      h('h3.card-title', { text: 'About Zenith' }),
      h('p.card-text', {
        text: 'An offline-first envelope budget where credit cards are first-class: spending on a card funds its payment envelope, so the statement is always covered by a plan rather than a surprise.',
      }),
      h('dl.about-list', null,
        aboutRow('Storage', 'This browser only (localStorage)'),
        aboutRow('Accounts', String(state.accounts.length)),
        aboutRow('Transactions', String(state.transactions.length)),
        aboutRow('Utilisation warning', formatPercent(state.settings.utilizationWarn ?? 0.3)),
      ),
    ),
  );

  return root;
}

function integrityRow(label: string, cents: Cents, money: Required<Pick<MoneyOptions, 'currency' | 'locale'>>, emphasis = false): HTMLElement {
  return h(
    'li',
    { class: `integrity-row${emphasis ? ' is-total' : ''}` },
    h('span', { text: label }),
    h('span.integrity-value', { text: formatMoney(cents, money) }),
  );
}

function aboutRow(label: string, value: string): HTMLElement {
  return h('div.about-row', null, h('dt', { text: label }), h('dd', { text: value }));
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function download(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = h<HTMLAnchorElement>('a', { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`${filename} saved.`, { tone: 'success' });
}
