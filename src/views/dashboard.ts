/** Dashboard — the month at a glance, cash and cards side by side. */

import { h, append } from './../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { statTile, statusPill, sectionHeader, emptyState } from '../ui/components.ts';
import { meter, categoryBars } from '../ui/charts.ts';
import { openTransactionForm, openPaymentForm, openFundCardForm, openAccountForm } from '../ui/forms.ts';
import { formatMoney } from '../core/money.ts';
import {
  addMonths, currentMonth, formatDateShort, monthLabel, relativeDays,
} from '../core/dates.ts';
import {
  cashOnHand, monthSummary, categoryRow, queryTransactions, spendingByCategory,
} from '../core/budget.ts';
import { debtSummary, upcomingPayments } from '../core/cards.ts';
import { upcomingLoanPayments } from '../core/loans.ts';
import { getState, moneyOpts } from '../store.ts';
import { enableReminders, notificationPermission, notificationsSupported, remindersOn } from '../reminders.ts';
import { toast } from '../ui/toast.ts';
import { navigate } from '../router.ts';
import { transactionRow } from './transactions.ts';
import { foldToOther, toCategoryRows } from './chart-data.ts';
import type { MonthKey, MoneyOptions } from '../core/model.ts';
import type { CardSnapshot } from '../core/cards.ts';

export function dashboardView({ month = currentMonth() }: { month?: MonthKey } = {}): HTMLElement {
  const state = getState();
  const money = moneyOpts(state);
  const root = h('div.view.view-dashboard');

  if (!state.accounts.length) {
    append(
      root,
      emptyState({
        title: 'Welcome to Zenith',
        message:
          'Add your first account to start. Add a credit card too, and every charge will automatically set money aside for the bill.',
        iconName: 'wallet',
        action: h(
          'div.empty-actions',
          null,
          h('button.btn.btn-primary', { type: 'button', text: 'Add an account', onclick: () => openAccountForm() }),
          h('a.btn', { href: '#/settings', text: 'Load sample data' }),
        ),
      }),
    );
    return root;
  }

  const summary = monthSummary(state, month);
  const debt = debtSummary(state, { month });
  const cash = cashOnHand(state);
  const previous = monthSummary(state, addMonths(month, -1));

  /* Hero: the one number this view leads with. */
  const rta = summary.readyToAssign;
  const rtaTone = rta < 0 ? 'critical' : rta === 0 ? 'good' : 'accent';
  append(
    root,
    h(
      'section.hero',
      null,
      h(
        'div.hero-main',
        null,
        h('p.hero-label', { text: `Ready to assign · ${monthLabel(month, money.locale)}` }),
        h('p', { class: `hero-figure tone-${rtaTone}`, text: formatMoney(rta, money) }),
        h(
          'p.hero-note',
          null,
          rta < 0
            ? statusPill('critical', 'Over-assigned — pull money back from a category')
            : rta === 0
              ? statusPill('good', 'Every dollar has a job')
              : statusPill('warning', 'Unassigned cash — give it a job'),
        ),
      ),
      h(
        'div.hero-actions',
        null,
        h(
          'button.btn.btn-primary',
          { type: 'button', onclick: () => openTransactionForm({ defaults: { kind: 'expense' } }) },
          icon('plus', { size: 16 }),
          h('span', { text: 'Add transaction' }),
        ),
        h('a.btn', { href: '#/budget' }, icon('budget', { size: 16 }), h('span', { text: 'Open budget' })),
      ),
    ),
  );

  /* Stat tiles. */
  append(
    root,
    h(
      'div.tile-grid',
      null,
      statTile({
        label: 'Cash on hand',
        value: formatMoney(cash, { ...money, cents: false }),
        hint: 'Across chequing, savings, cash and wallets',
        tone: 'neutral',
      }),
      statTile({
        label: 'Card debt',
        value: formatMoney(debt.balance, { ...money, cents: false }),
        hint:
          debt.uncovered > 0
            ? `${formatMoney(debt.uncovered, { ...money, cents: false })} not yet funded`
            : 'Fully funded by the budget',
        tone: debt.uncovered > 0 ? 'critical' : 'good',
        href: '#/cards',
      }),
      statTile({
        label: 'Spent this month',
        value: formatMoney(summary.spending, { ...money, cents: false }),
        delta: previous.spending ? summary.spending - previous.spending : null,
        deltaLabel: previous.spending
          ? formatMoney(Math.abs(summary.spending - previous.spending), { ...money, cents: false })
          : null,
        upIsGood: false,
        hint: previous.spending ? `vs ${monthLabel(addMonths(month, -1), money.locale, { month: 'long' })}` : undefined,
      }),
      statTile({
        label: 'Income this month',
        value: formatMoney(summary.income, { ...money, cents: false }),
        hint: `${formatMoney(summary.budgeted, { ...money, cents: false })} assigned`,
      }),
    ),
  );

  /* Cards — the connection made visible. */
  if (debt.cards.length) {
    const cardStrip = h('div.card-strip');
    for (const snap of debt.cards) {
      cardStrip.appendChild(cardTile(snap, money, month));
    }
    append(
      root,
      h(
        'section.block',
        null,
        sectionHeader('Credit cards', {
          subtitle: 'Each card carries a payment envelope funded by the spending you put on it.',
          actions: h('a.btn.btn-sm', { href: '#/cards', text: 'Manage cards' }),
        }),
        cardStrip,
      ),
    );
  }

  /* Payments due. */
  const due = upcomingPayments(state, { days: 30 });
  // A loan payment is due just as a card payment is, and missing one costs
  // more, so both belong in the same list.
  const loansDue = upcomingLoanPayments(state, { days: 30 });
  if (due.length || loansDue.length) {
    append(
      root,
      h(
        'section.block',
        null,
        sectionHeader('Payments due', { subtitle: 'Next 30 days', actions: remindMeButton() }),
        h(
          'ul.due-list',
          { role: 'list' },
          due.map((snap) => {
            const days = snap.cycle.daysUntilDue;
            const status = snap.cycle.overdue ? 'critical' : days <= 3 ? 'serious' : days <= 7 ? 'warning' : 'neutral';
            return h(
              'li.due-row',
              null,
              h('div.due-icon', null, icon('calendar', { size: 18 })),
              h(
                'div.due-main',
                null,
                h('p.due-name', { text: snap.card.name }),
                h('p.due-meta', {
                  text: `${formatDateShort(snap.cycle.dueDate, money.locale)} · ${relativeDays(days)}`,
                }),
              ),
              h(
                'div.due-figures',
                null,
                // Plain ink: an amount owed is not a gain, so it never wears
                // the positive-money green.
                h('p.due-amount', { text: formatMoney(snap.statementBalance || snap.balance, money) }),
                h('p.due-min', { text: `min ${formatMoney(snap.minimumPayment, { ...money, cents: false })}` }),
              ),
              h('div.due-status', null, statusPill(status, snap.cycle.overdue ? 'Overdue' : relativeDays(days), { size: 'sm' })),
              h('button.btn.btn-sm.btn-primary', {
                type: 'button',
                text: 'Pay',
                onclick: () => openPaymentForm(snap.card.id),
              }),
            );
          }),
          loansDue.map((snap) => {
            const days = snap.daysUntilDue;
            const status = days < 0 ? 'critical' : days <= 3 ? 'serious' : days <= 7 ? 'warning' : 'neutral';
            return h(
              'li.due-row',
              null,
              h('div.due-icon', null, icon('budget', { size: 18 })),
              h(
                'div.due-main',
                null,
                h('p.due-name', { text: snap.loan.name }),
                h('p.due-meta', {
                  text: `${formatDateShort(snap.nextDueDate, money.locale)} · ${relativeDays(days)}`,
                }),
              ),
              h(
                'div.due-figures',
                null,
                h('p.due-amount', { text: formatMoney(snap.loan.monthlyPayment, money) }),
                h('p.due-min', {
                  text: snap.loan.termMonths
                    ? `${snap.paymentsRemaining} left`
                    : formatMoney(snap.balance, { ...money, cents: false }) + ' owed',
                }),
              ),
              h(
                'div.due-status',
                null,
                statusPill(
                  snap.readyForNextPayment ? 'good' : status,
                  snap.readyForNextPayment ? 'Funded' : relativeDays(days),
                  { size: 'sm' },
                ),
              ),
              h('button.btn.btn-sm.btn-primary', {
                type: 'button',
                text: 'Pay',
                onclick: () =>
                  openTransactionForm({
                    defaults: { kind: 'transfer', toAccountId: snap.loan.id, amount: snap.loan.monthlyPayment },
                  }),
              }),
            );
          }),
        ),
      ),
    );
  }

  /* Unfunded debt callout — the single most useful nudge in the app. */
  if (debt.uncovered > 0) {
    const worst = [...debt.cards].sort((a, b) => b.uncovered - a.uncovered)[0];
    append(
      root,
      h(
        'section',
        { class: 'callout callout-critical' },
        h('div.callout-icon', null, icon('alert', { size: 20 })),
        h(
          'div.callout-body',
          null,
          h('h3.callout-title', { text: `${formatMoney(debt.uncovered, money)} of card debt isn't funded` }),
          h('p.callout-text', {
            text: `This is the part of your balance with no cash set aside — it is what accrues interest, roughly ${formatMoney(debt.monthlyInterestCost, money)} a month at your current rates.`,
          }),
        ),
        h('button.btn.btn-primary', {
          type: 'button',
          text: `Fund ${worst.card.name}`,
          onclick: () => openFundCardForm(worst.card.id, { month }),
        }),
      ),
    );
  }

  /* Budget progress — the categories closest to the edge first. */
  const rows = state.categories
    .filter((c) => c.kind === 'spending' && !c.archived)
    .map((category) => {
      const row = categoryRow(summary, category.id);
      const assigned = row.rollover + row.budgeted;
      const spent = -Math.min(0, row.activity);
      return { category, row, assigned, spent, ratio: assigned ? spent / assigned : spent ? Infinity : 0 };
    })
    .filter((entry) => entry.assigned > 0 || entry.spent > 0)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 6);

  if (rows.length) {
    append(
      root,
      h(
        'section.block',
        null,
        sectionHeader('Closest to the limit', {
          subtitle: 'Where this month’s envelopes stand',
          actions: h('a.btn.btn-sm', { href: '#/budget', text: 'Full budget' }),
        }),
        h(
          'div.progress-list',
          null,
          rows.map((entry) => {
            const over = entry.row.available < 0;
            const status = over ? 'critical' : entry.ratio >= 0.9 ? 'serious' : entry.ratio >= 0.7 ? 'warning' : 'accent';
            return h(
              'div.progress-row',
              null,
              h(
                'div.progress-head',
                null,
                h('span.progress-swatch', { style: { background: `var(--${entry.category.color})` } }),
                h('span.progress-name', { text: entry.category.name }),
                h(
                  'span.progress-figures',
                  null,
                  h('span.progress-spent', { text: formatMoney(entry.spent, { ...money, cents: false }) }),
                  h('span.progress-of', { text: ` of ${formatMoney(entry.assigned, { ...money, cents: false })}` }),
                ),
              ),
              meter({
                ratio: entry.ratio,
                status,
                ariaLabel: `${entry.category.name}: ${formatMoney(entry.spent, money)} spent of ${formatMoney(entry.assigned, money)} assigned`,
              }),
              over
                ? h('p.progress-note', null, statusPill('critical', `Over by ${formatMoney(-entry.row.available, money)}`, { size: 'sm' }))
                : null,
            );
          }),
        ),
      ),
    );
  }

  /* Where the money went. */
  const spending = spendingByCategory(state, month, month);
  const byId = new Map(state.categories.map((c) => [c.id, c]));
  const folded = foldToOther(toCategoryRows(spending, byId), 8);

  append(
    root,
    h(
      'section.block',
      null,
      categoryBars(folded, {
        title: 'Where the money went',
        subtitle: monthLabel(month, money.locale),
        money,
        emptyMessage: 'No spending recorded this month yet.',
      }),
    ),
  );

  /* Recent activity. */
  const recent = queryTransactions(state, { limit: 8 });
  append(
    root,
    h(
      'section.block',
      null,
      sectionHeader('Recent activity', {
        actions: h('a.btn.btn-sm', { href: '#/transactions', text: 'All transactions' }),
      }),
      recent.length
        ? h('ul.tx-list', { role: 'list' }, recent.map((tx) => transactionRow(tx, state, money)))
        : h('p.muted-note', { text: 'Nothing recorded yet.' }),
    ),
  );

  return root;
}

/**
 * Offered beside the bills it would be about, which is the only place the ask
 * makes sense — and only while it can be granted. Once reminders are on, or the
 * browser has been told no, the button has nothing to offer and disappears.
 */
function remindMeButton(): HTMLElement | undefined {
  if (!notificationsSupported() || notificationPermission() === 'denied' || remindersOn()) return undefined;
  return h(
    'button.btn.btn-sm',
    {
      type: 'button',
      title: 'Get a notification before a payment is due',
      onclick: async () => {
        const result = await enableReminders();
        if (result === 'granted') toast('Reminders on — Settings has the details.', { tone: 'success' });
        else toast('Your browser did not allow notifications.', { tone: 'warning' });
      },
    },
    icon('bell', { size: 15 }),
    h('span', { text: 'Remind me' }),
  );
}

function cardTile(snap: CardSnapshot, money: Required<Pick<MoneyOptions, 'currency' | 'locale'>>, month: MonthKey): HTMLElement {
  const { card, band } = snap;
  return h(
    'article.mini-card',
    null,
    h(
      'header.mini-card-head',
      null,
      h('div.mini-card-icon', null, icon('card', { size: 18 })),
      h(
        'div',
        null,
        h('h3.mini-card-name', { text: card.name }),
        h('p.mini-card-meta', {
          text: `${formatMoney(snap.availableCredit, { ...money, cents: false })} available`,
        }),
      ),
      statusPill(band.status, band.label, { size: 'sm' }),
    ),
    h(
      'div.mini-card-figure',
      null,
      h('span.mini-card-amount', { text: formatMoney(snap.balance, money) }),
      h('span.mini-card-caption', { text: 'balance owed' }),
    ),
    meter({
      ratio: snap.utilization ?? 0,
      status: band.status === 'good' ? 'accent' : band.status,
      label: 'Utilisation',
      caption: snap.utilization == null ? 'No limit set' : `${Math.round(snap.utilization * 100)}%`,
      ariaLabel: `${card.name} utilisation`,
    }),
    h(
      'div.coverage',
      null,
      h(
        'div.coverage-head',
        null,
        h('span.coverage-label', { text: 'Funded by budget' }),
        h('span.coverage-value', {
          text: `${formatMoney(snap.reserved, { ...money, cents: false })} of ${formatMoney(snap.balance, { ...money, cents: false })}`,
        }),
      ),
      meter({
        ratio: snap.coverageRatio,
        status: snap.covered ? 'good' : 'warning',
        ariaLabel: `${card.name} funding coverage`,
      }),
      snap.covered
        ? statusPill('good', 'Payable in full', { size: 'sm' })
        : statusPill('warning', `${formatMoney(snap.uncovered, { ...money, cents: false })} unfunded`, { size: 'sm' }),
    ),
    h(
      'footer.mini-card-foot',
      null,
      h('button.btn.btn-sm.btn-primary', {
        type: 'button',
        text: 'Pay',
        onclick: () => openPaymentForm(card.id),
      }),
      !snap.covered
        ? h('button.btn.btn-sm', {
            type: 'button',
            text: 'Fund',
            onclick: () => openFundCardForm(card.id, { month }),
          })
        : null,
      h('button.btn.btn-sm.btn-ghost', {
        type: 'button',
        text: 'Details',
        onclick: () => navigate(`#/cards/${card.id}`),
      }),
    ),
  );
}
