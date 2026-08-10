/** Settings — preferences, data portability, and a budget integrity check. */

import { h, append } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { sectionHeader, statusPill, field, select, input } from '../ui/components.ts';
import { confirmDialog } from '../ui/modal.ts';
import { toast } from '../ui/toast.ts';
import { formatMoney, formatPercent } from '../core/money.ts';
import { currentMonth, daysBetween, formatDateShort, relativeDays, todayISO } from '../core/dates.ts';
import { reconcile } from '../core/budget.ts';
import { seedState } from '../core/seed.ts';
import { pendingReminders, reminderSettings } from '../core/reminders.ts';
import * as actions from '../core/actions.ts';
import {
  clearAll, commit, getState, moneyOpts, replaceState, undo, updateSettings,
} from '../store.ts';
import { installState, promptInstall, applyUpdate, checkForUpdate } from '../pwa.ts';
import {
  backgroundDeliverySupported, disableReminders, enableReminders, notificationPermission,
  notificationsSupported, sendTestNotification, setReminderSettings,
} from '../reminders.ts';
import { isEmbedded } from '../core/model.ts';
import type { AppState, Cents, MoneyOptions, ThemePreference } from '../core/model.ts';

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
      // Whether a new version is waiting, stated plainly. A toast lasts
      // seconds; this is where someone comes looking afterwards.
      !isEmbedded() && install.updateReady
        ? h(
            'div.block',
            null,
            h('p.card-text', null,
              statusPill('good', 'Update ready', { size: 'sm' }),
              h('span', { text: 'A new version has been downloaded and is ready to use.' }),
            ),
            h('div.button-row', null,
              h(
                'button.btn.btn-primary',
                { type: 'button', onclick: () => applyUpdate() },
                icon('undo', { size: 16 }),
                h('span', { text: 'Reload to update' }),
              ),
            ),
          )
        : null,
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
        ? h(
            'div',
            null,
            h('p.card-text', null, statusPill('good', 'Installed', { size: 'sm' }), h('span', { text: 'Zenith is running as an installed app.' })),
            checkForUpdateButton(install.updateReady),
          )
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
            checkForUpdateButton(install.updateReady),
          ),
    ),
  );

  /* Reminders. */
  append(root, remindersSection(state));

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
                'aria-label': `${category.archived ? 'Restore' : 'Archive'} ${category.name}`,
                title: category.archived ? 'Restore — bring it back into the budget' : 'Archive — hide it, keep its history',
                onclick: () =>
                  commit((s) => actions.updateCategory(s, category.id, { archived: !category.archived }), {
                    label: 'archive category',
                  }),
              }, icon(category.archived ? 'undo' : 'archive', { size: 15 })),
              h('button.icon-btn.icon-btn-danger', {
                type: 'button',
                'aria-label': `Delete ${category.name}`,
                title: 'Delete permanently',
                onclick: async () => {
                  const ok = await confirmDialog({
                    title: `Delete ${category.name}?`,
                    message: 'Transactions keep their history but become uncategorised. This cannot be undone from another device.',
                    confirmLabel: 'Delete',
                    danger: true,
                  });
                  if (!ok) return;
                  commit((s) => actions.deleteCategory(s, category.id), { label: 'delete category' });
                  toast('Category deleted.', { tone: 'success', action: { label: 'Undo', onClick: () => undo() } });
                },
              }, icon('trash', { size: 15 })),
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

const LEAD_DAYS = [
  { value: '0', label: 'On the due date only' },
  { value: '1', label: '1 day before' },
  { value: '2', label: '2 days before' },
  { value: '3', label: '3 days before' },
  { value: '5', label: '5 days before' },
  { value: '7', label: 'A week before' },
];

/**
 * Reminders. There is no server behind these — the schedule is derived from the
 * budget on this device — so the copy says what will and will not arrive rather
 * than implying a push service that does not exist.
 */
function remindersSection(state: AppState): HTMLElement {
  const settings = reminderSettings(state);
  const permission = notificationPermission();
  const section = h('section.card.block', null, h('h3.card-title', { text: 'Reminders' }));

  if (!notificationsSupported()) {
    append(
      section,
      h('p.card-text', {
        text: isEmbedded()
          ? 'The single-file preview cannot raise notifications — that needs the service worker only the full app ships with.'
          : 'This browser does not offer notifications, so Zenith cannot remind you here. Everything else works as normal.',
      }),
    );
    return section;
  }

  append(
    section,
    h('p.card-text', {
      text: 'Zenith can raise a system notification when a card payment or a recurring bill is coming up. Reminders are worked out on this device from your own budget — nothing is sent to a server, and no account is involved.',
    }),
  );

  if (permission === 'denied') {
    append(
      section,
      h(
        'p.card-text',
        null,
        statusPill('warning', 'Blocked', { size: 'sm' }),
        h('span', {
          text: 'Notifications are blocked for this site. Allow them in your browser’s site settings, then come back here to switch reminders on.',
        }),
      ),
    );
    return section;
  }

  const on = settings.enabled && permission === 'granted';

  append(
    section,
    h(
      'label.check-row',
      null,
      h<HTMLInputElement>('input', {
        type: 'checkbox',
        class: 'checkbox',
        checked: on,
        onchange: async (event: Event) => {
          const wanted = (event.target as HTMLInputElement).checked;
          if (!wanted) {
            await disableReminders();
            toast('Reminders off.', { tone: 'info' });
            return;
          }
          const result = await enableReminders();
          if (result === 'granted') toast('Reminders on.', { tone: 'success' });
          else {
            (event.target as HTMLInputElement).checked = false;
            toast('Your browser did not allow notifications.', { tone: 'warning' });
          }
        },
      }),
      h('span', { text: 'Remind me about my cards' }),
    ),
  );

  if (!on) return section;

  append(
    section,
    h(
      'div.form-grid.block',
      null,
      field(
        'First nudge',
        select(
          LEAD_DAYS.map((option) => ({ ...option, selected: Number(option.value) === settings.leadDays })),
          {
            onchange: (event: Event) =>
              setReminderSettings({ leadDays: Number((event.target as HTMLSelectElement).value) || 0 }),
          },
        ),
        { id: 'set-lead-days', hint: 'A second reminder always lands on the due date itself.' },
      ),
    ),
    h(
      'div.check-list.block',
      null,
      reminderToggle('Payments due and overdue', settings.payments, (payments) => setReminderSettings({ payments })),
      reminderToggle('Recurring bills coming due', settings.bills, (bills) => setReminderSettings({ bills })),
      reminderToggle('Unfunded card debt', settings.unfunded, (unfunded) => setReminderSettings({ unfunded })),
      reminderToggle('The day a statement closes', settings.statements, (statements) =>
        setReminderSettings({ statements }),
      ),
    ),
    h(
      'div.button-row.block',
      null,
      h(
        'button.btn',
        {
          type: 'button',
          onclick: async () => {
            const sent = await sendTestNotification();
            if (!sent) toast('That notification could not be shown.', { tone: 'error' });
          },
        },
        icon('bell', { size: 16 }),
        h('span', { text: 'Send a test notification' }),
      ),
    ),
    h('p.muted-note.block', null, icon('info', { size: 15 }), h('span', {
      text: backgroundDeliverySupported()
        ? 'Reminders arrive while Zenith is open, and in the background when your browser wakes the app — install Zenith for the best chance of that. Amounts are as of the last time you opened it.'
        : 'This browser only runs Zenith while it is open, so a reminder arrives the next time you open the app rather than at the moment it comes due.',
    })),
  );

  const upcoming = pendingReminders(state).slice(0, 4);
  append(
    section,
    upcoming.length
      ? h(
          'ul.mini-list.block',
          { role: 'list' },
          upcoming.map((reminder) => {
            const days = daysBetween(todayISO(), reminder.fireOn);
            return h(
              'li.mini-row',
              null,
              // The notification's own words, so this is a preview rather than a
              // description of one — which is why the date says "arrives": the
              // title is written for the day it lands on, not for today.
              h('span.mini-name', { text: reminder.title }),
              h('span.mini-meta', {
                text: days <= 0
                  ? 'arrives now'
                  : `arrives ${formatDateShort(reminder.fireOn, state.settings.locale)} · ${relativeDays(days)}`,
              }),
            );
          }),
        )
      : h('p.muted-note.block', null, icon('check', { size: 15 }), h('span', {
          text: 'Nothing to remind you about — no card has a balance with a payment coming up.',
        })),
  );

  return section;
}

function reminderToggle(label: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
  return h(
    'label.check-row',
    null,
    h<HTMLInputElement>('input', {
      type: 'checkbox',
      class: 'checkbox',
      checked,
      onchange: (event: Event) => onChange((event.target as HTMLInputElement).checked),
    }),
    h('span', { text: label }),
  );
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

/**
 * Ask for a new version now.
 *
 * Zenith checks by itself when it is opened and while it is left open, so this
 * is for the moment someone knows a change has shipped and does not want to
 * wait for the next check.
 */
function checkForUpdateButton(updateReady: boolean): HTMLElement | null {
  if (updateReady) return null;
  return h(
    'div.button-row.block',
    null,
    h(
      'button.btn',
      {
        type: 'button',
        onclick: () => {
          checkForUpdate();
          // There is nothing to report synchronously: if a new version exists,
          // the header button and this section appear on their own once it has
          // downloaded.
          toast('Checking for a new version…', { tone: 'info' });
        },
      },
      icon('spark', { size: 16 }),
      h('span', { text: 'Check for updates' }),
    ),
  );
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
