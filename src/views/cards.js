/**
 * Credit cards — the other half of the app.
 *
 * Every figure here is either an account fact (balance, limit, APR, dates) or a
 * budget fact (what the payment envelope holds). Presenting them together is
 * the whole point: a card balance means something different depending on
 * whether the budget has cash behind it.
 */

import { h, append, mount } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { statTile, statusPill, sectionHeader, emptyState, field, moneyInput } from '../ui/components.js';
import { meter, lineChart, tableView } from '../ui/charts.js';
import { openAccountForm, openPaymentForm, openFundCardForm, openTransactionForm } from '../ui/forms.js';
import { formatMoney, formatPercent, parseMoney, centsToInput } from '../core/money.js';
import { currentMonth, formatDate, formatDateShort, monthLabel, relativeDays } from '../core/dates.js';
import { queryTransactions } from '../core/budget.js';
import { cardSnapshot, creditAccounts, debtSummary, payoffComparison } from '../core/cards.js';
import { getState, moneyOpts } from '../store.js';
import { navigate } from '../router.js';
import { transactionRow } from './transactions.js';

/* ── List ─────────────────────────────────────────────────────────────── */

export function cardsView({ month = currentMonth() } = {}) {
  const state = getState();
  const money = moneyOpts(state);
  const root = h('div.view.view-cards');

  const cards = creditAccounts(state);
  if (!cards.length) {
    append(
      root,
      emptyState({
        title: 'No credit cards yet',
        message:
          'Add a card and Zenith creates a payment envelope for it. Charges then draw down the category you pick and set the same cash aside for the bill, so the statement never surprises you.',
        iconName: 'card',
        action: h('button.btn.btn-primary', {
          type: 'button',
          text: 'Add a credit card',
          onclick: () => openAccountForm({ presetType: 'credit' }),
        }),
      }),
    );
    return root;
  }

  const debt = debtSummary(state, { month });

  append(
    root,
    sectionHeader('Credit cards', {
      subtitle: 'Balances, funding and what each card is costing you',
      actions: h(
        'button.btn.btn-primary',
        { type: 'button', onclick: () => openAccountForm({ presetType: 'credit' }) },
        icon('plus', { size: 16 }),
        h('span', { text: 'Add card' }),
      ),
    }),
    h(
      'div.tile-grid',
      null,
      statTile({
        label: 'Total owed',
        value: formatMoney(debt.balance, { ...money, cents: false }),
        hint: `across ${debt.cards.length} card${debt.cards.length === 1 ? '' : 's'}`,
      }),
      statTile({
        label: 'Funded by budget',
        value: formatMoney(debt.reserved, { ...money, cents: false }),
        hint: debt.uncovered > 0 ? `${formatMoney(debt.uncovered, { ...money, cents: false })} short` : 'Payable in full',
        tone: debt.uncovered > 0 ? 'warning' : 'good',
      }),
      statTile({
        label: 'Overall utilisation',
        value: debt.utilization == null ? '—' : formatPercent(debt.utilization),
        hint: debt.limit ? `of ${formatMoney(debt.limit, { ...money, cents: false })} in limits` : 'No limits set',
        tone: debt.band.status === 'good' ? 'good' : debt.band.status,
      }),
      statTile({
        label: 'Interest if nothing changes',
        value: formatMoney(debt.monthlyInterestCost, { ...money, cents: false }),
        hint: 'per month on unfunded balances',
        tone: debt.monthlyInterestCost > 0 ? 'warning' : 'good',
      }),
    ),
  );

  const list = h('div.card-grid');
  for (const snap of debt.cards) list.appendChild(fullCard(snap, money, month));
  append(root, list);

  return root;
}

function fullCard(snap, money, month) {
  const { card, band, cycle } = snap;
  const dueStatus = cycle.overdue
    ? 'critical'
    : cycle.daysUntilDue <= 3
      ? 'serious'
      : cycle.daysUntilDue <= 7
        ? 'warning'
        : 'neutral';

  return h(
    'article.card.credit-card',
    null,
    h(
      'header.credit-card-head',
      null,
      h(
        'div.credit-card-title',
        null,
        h('div.credit-card-chip', null, icon('card', { size: 20 })),
        h(
          'div',
          null,
          h(
            'button.credit-card-name',
            { type: 'button', onclick: () => navigate(`#/cards/${card.id}`) },
            h('span', { text: card.name }),
          ),
          h('p.credit-card-terms', {
            text: `${card.apr ? formatPercent(card.apr, 2) + ' APR' : 'APR not set'} · closes ${ordinal(card.statementDay)} · due ${ordinal(card.dueDay)}`,
          }),
        ),
      ),
      statusPill(band.status, band.label, { size: 'sm' }),
    ),

    h(
      'div.credit-card-figures',
      null,
      figureCell('Balance owed', formatMoney(snap.balance, money), 'primary'),
      figureCell('Available credit', formatMoney(snap.availableCredit, { ...money, cents: false })),
      figureCell('Statement', formatMoney(snap.statementBalance, { ...money, cents: false })),
      figureCell('Minimum', formatMoney(snap.minimumPayment, { ...money, cents: false })),
    ),

    meter({
      ratio: snap.utilization ?? 0,
      status: band.status === 'good' ? 'accent' : band.status,
      label: 'Utilisation',
      caption:
        snap.utilization == null
          ? 'Set a limit to track this'
          : `${formatPercent(snap.utilization)} of ${formatMoney(card.creditLimit, { ...money, cents: false })}`,
      ariaLabel: `${card.name} utilisation`,
    }),

    /* The connection, stated plainly. */
    h(
      'div',
      { class: `coverage-panel ${snap.covered ? 'is-covered' : 'is-short'}` },
      h(
        'div.coverage-head',
        null,
        h('span.coverage-label', null, icon('link', { size: 15 }), h('span', { text: 'Funded by your budget' })),
        h('span.coverage-value', {
          text: `${formatMoney(snap.reserved, money)} of ${formatMoney(snap.balance, money)}`,
        }),
      ),
      meter({
        ratio: snap.coverageRatio,
        status: snap.covered ? 'good' : 'warning',
        ariaLabel: `${card.name} funding coverage`,
      }),
      snap.covered
        ? h(
            'p.coverage-note',
            null,
            statusPill('good', 'Payable in full', { size: 'sm' }),
            h('span', { text: 'Your budget holds enough to clear this card today.' }),
          )
        : h(
            'p.coverage-note',
            null,
            statusPill('warning', `${formatMoney(snap.uncovered, money)} unfunded`, { size: 'sm' }),
            h('span', {
              text: `Carrying it costs about ${formatMoney(snap.monthlyInterestCost, money)} a month in interest.`,
            }),
          ),
    ),

    h(
      'div.credit-card-cycle',
      null,
      h(
        'div.cycle-item',
        null,
        icon('calendar', { size: 16 }),
        h(
          'div',
          null,
          h('p.cycle-label', { text: 'Payment due' }),
          h('p.cycle-value', { text: `${formatDateShort(cycle.dueDate, money.locale)} · ${relativeDays(cycle.daysUntilDue)}` }),
        ),
        statusPill(dueStatus, cycle.overdue ? 'Overdue' : 'Scheduled', { size: 'sm' }),
      ),
      h(
        'div.cycle-item',
        null,
        icon('spark', { size: 16 }),
        h(
          'div',
          null,
          h('p.cycle-label', { text: 'This month' }),
          h('p.cycle-value', {
            text: `${formatMoney(snap.spentThisMonth, { ...money, cents: false })} spent · ${formatMoney(snap.paidThisMonth, { ...money, cents: false })} paid`,
          }),
        ),
      ),
    ),

    h(
      'footer.credit-card-foot',
      null,
      h(
        'button.btn.btn-primary',
        { type: 'button', onclick: () => openPaymentForm(card.id) },
        icon('transfer', { size: 16 }),
        h('span', { text: 'Pay card' }),
      ),
      h(
        'button.btn',
        { type: 'button', onclick: () => openTransactionForm({ defaults: { accountId: card.id, kind: 'expense' } }) },
        icon('plus', { size: 16 }),
        h('span', { text: 'Add charge' }),
      ),
      !snap.covered
        ? h('button.btn', {
            type: 'button',
            text: 'Fund shortfall',
            onclick: () => openFundCardForm(card.id, { month }),
          })
        : null,
      h('div.foot-spacer'),
      h('button.btn.btn-ghost', { type: 'button', text: 'Details', onclick: () => navigate(`#/cards/${card.id}`) }),
    ),
  );
}

function figureCell(label, value, tone = '') {
  return h(
    'div',
    { class: `figure-cell ${tone}`.trim() },
    h('span.figure-label', { text: label }),
    h('span.figure-value', { text: value }),
  );
}

function ordinal(day) {
  const n = Number(day) || 1;
  const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/* ── Detail ───────────────────────────────────────────────────────────── */

export function cardDetailView({ cardId, month = currentMonth() } = {}) {
  const state = getState();
  const money = moneyOpts(state);
  const card = state.accounts.find((a) => a.id === cardId);
  const root = h('div.view.view-card-detail');

  if (!card) {
    append(
      root,
      emptyState({
        title: 'Card not found',
        message: 'It may have been deleted.',
        iconName: 'card',
        action: h('a.btn', { href: '#/cards', text: 'Back to cards' }),
      }),
    );
    return root;
  }

  const snap = cardSnapshot(state, card, { month });

  append(
    root,
    h(
      'div.detail-bar',
      null,
      h('a.btn.btn-ghost.btn-sm', { href: '#/cards' }, icon('arrowLeft', { size: 16 }), h('span', { text: 'Cards' })),
      h('div.foot-spacer'),
      h(
        'button.btn.btn-sm',
        { type: 'button', onclick: () => openAccountForm({ account: card }) },
        icon('edit', { size: 15 }),
        h('span', { text: 'Edit card' }),
      ),
    ),
    sectionHeader(card.name, {
      subtitle: `${card.apr ? formatPercent(card.apr, 2) + ' APR' : 'APR not set'} · limit ${formatMoney(card.creditLimit, { ...money, cents: false })} · statement closes ${ordinal(card.statementDay)}, due ${ordinal(card.dueDay)}`,
      actions: h(
        'button.btn.btn-primary',
        { type: 'button', onclick: () => openPaymentForm(card.id) },
        icon('transfer', { size: 16 }),
        h('span', { text: 'Pay card' }),
      ),
    }),
    h(
      'div.tile-grid',
      null,
      statTile({ label: 'Balance owed', value: formatMoney(snap.balance, money) }),
      statTile({
        label: 'Funded by budget',
        value: formatMoney(snap.reserved, money),
        tone: snap.covered ? 'good' : 'warning',
        hint: snap.covered ? 'Payable in full' : `${formatMoney(snap.uncovered, { ...money, cents: false })} short`,
      }),
      statTile({
        label: 'Utilisation',
        value: snap.utilization == null ? '—' : formatPercent(snap.utilization),
        tone: snap.band.status === 'good' ? 'good' : snap.band.status,
        hint: snap.band.label,
      }),
      statTile({
        label: 'Next payment due',
        value: formatDateShort(snap.cycle.dueDate, money.locale),
        hint: `${relativeDays(snap.cycle.daysUntilDue)} · min ${formatMoney(snap.minimumPayment, { ...money, cents: false })}`,
        tone: snap.cycle.overdue ? 'critical' : 'neutral',
      }),
    ),
  );

  /* Statement cycle explainer. */
  append(
    root,
    h(
      'section.card.block',
      null
      ,
      sectionHeader('Statement cycle', { subtitle: 'Where you are in the current period' }),
      h(
        'ol.cycle-timeline',
        { role: 'list' },
        timelineStep('Last statement closed', formatDate(snap.cycle.lastClose, money.locale), 'done'),
        timelineStep(
          'Payment due',
          `${formatDate(snap.cycle.dueDate, money.locale)} · ${relativeDays(snap.cycle.daysUntilDue)}`,
          snap.cycle.overdue ? 'overdue' : 'next',
        ),
        timelineStep(
          'Next statement closes',
          `${formatDate(snap.cycle.nextClose, money.locale)} · ${relativeDays(snap.cycle.daysUntilClose)}`,
          'future',
        ),
      ),
      h(
        'div.cycle-figures',
        null,
        figureCell('Statement balance', formatMoney(snap.statementBalance, money), 'primary'),
        figureCell('Charges since close', formatMoney(Math.max(0, snap.balance - snap.statementBalance), money)),
        figureCell('Minimum payment', formatMoney(snap.minimumPayment, money)),
        figureCell('Interest if carried', formatMoney(snap.monthlyInterestCost, money)),
      ),
    ),
  );

  /* Funding panel. */
  append(
    root,
    h(
      'section.card.block',
      null,
      sectionHeader('Budget connection', {
        subtitle: 'How this card and your envelopes stay in step',
      }),
      h(
        'div.connection-grid',
        null,
        connectionStep(
          '1',
          'You spend on the card',
          `${formatMoney(snap.spentThisMonth, money)} charged in ${monthLabel(month, money.locale, { month: 'long' })}. Each charge draws down the category you assigned it to.`,
          'card',
        ),
        connectionStep(
          '2',
          'The budget sets cash aside',
          `${formatMoney(snap.reserved, money)} is waiting in the "${snap.paymentCategory?.name ?? card.name}" payment envelope.`,
          'wallet',
        ),
        connectionStep(
          '3',
          'You pay the bill',
          `${formatMoney(snap.paidThisMonth, money)} paid this month. A payment spends the envelope, not a category — the spending was already budgeted.`,
          'transfer',
        ),
      ),
      snap.covered
        ? h(
            'p.coverage-note',
            null,
            statusPill('good', 'In step', { size: 'sm' }),
            h('span', { text: 'Nothing on this card is unfunded.' }),
          )
        : h(
            'div.callout callout-warning',
            { class: 'callout callout-warning' },
            h('div.callout-icon', null, icon('warn', { size: 20 })),
            h(
              'div.callout-body',
              null,
              h('h3.callout-title', { text: `${formatMoney(snap.uncovered, money)} unfunded` }),
              h('p.callout-text', {
                text: 'Assign money to this card’s payment envelope to turn the shortfall into a funded plan.',
              }),
            ),
            h('button.btn.btn-primary', {
              type: 'button',
              text: 'Assign money',
              onclick: () => openFundCardForm(card.id, { month }),
            }),
          ),
    ),
  );

  /* Payoff planner. */
  append(root, payoffPlanner(card, snap, money));

  /* Card transactions. */
  const transactions = queryTransactions(state, { accountId: card.id, limit: 40 });
  append(
    root,
    h(
      'section.block',
      null,
      sectionHeader('Card activity', { subtitle: 'Most recent 40 entries' }),
      transactions.length
        ? h('ul.tx-list', { role: 'list' }, transactions.map((tx) => transactionRow(tx, state, money)))
        : h('p.muted-note', { text: 'No activity on this card yet.' }),
    ),
  );

  return root;
}

function timelineStep(label, value, state) {
  const icons = { done: 'check', next: 'calendar', overdue: 'alert', future: 'info' };
  return h(
    'li',
    { class: `timeline-step is-${state}` },
    h('span.timeline-dot', null, icon(icons[state] ?? 'info', { size: 14 })),
    h('div', null, h('p.timeline-label', { text: label }), h('p.timeline-value', { text: value })),
  );
}

function connectionStep(number, title, text, iconName) {
  return h(
    'div.connection-step',
    null,
    h('span.connection-number', { text: number }),
    h('div.connection-icon', null, icon(iconName, { size: 18 })),
    h('div', null, h('h4.connection-title', { text: title }), h('p.connection-text', { text: text })),
  );
}

/**
 * Payoff planner: what a chosen monthly payment does to this balance, versus
 * paying only the minimum.
 */
function payoffPlanner(card, snap, money) {
  const section = h('section.card.block');
  const balance = snap.balance;

  if (balance <= 0) {
    append(
      section,
      sectionHeader('Payoff planner', { subtitle: 'Nothing to plan — this card is clear' }),
      h('p.muted-note', null, icon('check', { size: 16 }), h('span', { text: 'Balance is zero. Keep it that way.' })),
    );
    return section;
  }

  const minimum = snap.minimumPayment;
  const suggested = Math.max(minimum, Math.ceil(balance / 12 / 100) * 100);
  let payment = suggested;

  const output = h('div.payoff-output');
  const paymentInput = moneyInput({
    value: centsToInput(payment),
    'aria-label': 'Monthly payment',
  });

  const render = () => {
    const comparison = payoffComparison(card, balance, payment);
    const plan = comparison.plan;

    const points = [{ label: 'Now', value: balance }];
    const step = Math.max(1, Math.ceil(plan.schedule.length / 24));
    plan.schedule.forEach((entry, index) => {
      if (index % step === 0 || index === plan.schedule.length - 1) {
        points.push({ label: `M${entry.month}`, fullLabel: `Month ${entry.month}`, value: entry.balance });
      }
    });

    mount(
      output,
      plan.neverPaysOff
        ? h(
            'div.callout callout-critical',
            { class: 'callout callout-critical' },
            h('div.callout-icon', null, icon('alert', { size: 20 })),
            h(
              'div.callout-body',
              null,
              h('h3.callout-title', { text: 'This payment never clears the balance' }),
              h('p.callout-text', {
                text: `At ${formatPercent(card.apr, 2)} APR, interest alone is about ${formatMoney(snap.monthlyInterestCost || Math.round(balance * (card.apr / 12)), money)} a month. Pay more than that to make progress.`,
              }),
            ),
          )
        : h(
            'div.payoff-figures',
            null,
            figureCell('Paid off in', `${plan.months} month${plan.months === 1 ? '' : 's'}`, 'primary'),
            figureCell('Total interest', formatMoney(plan.totalInterest, money)),
            figureCell('Total paid', formatMoney(plan.totalPaid, money)),
            figureCell(
              'vs minimum only',
              comparison.interestSaved == null
                ? 'Minimum never clears it'
                : `${formatMoney(comparison.interestSaved, { ...money, cents: false })} saved`,
            ),
          ),
      !plan.neverPaysOff && points.length > 2
        ? lineChart(points, {
            title: 'Projected balance',
            subtitle: `Paying ${formatMoney(payment, money)} a month`,
            money,
            color: 'series-1',
            valueLabel: 'Balance',
          })
        : null,
      !plan.neverPaysOff
        ? tableView(
            ['Month', 'Payment', 'Interest', 'Principal', 'Balance'],
            plan.schedule
              .filter((entry, index) => index < 12 || index === plan.schedule.length - 1)
              .map((entry) => [
                `Month ${entry.month}`,
                formatMoney(entry.payment, money),
                formatMoney(entry.interest, money),
                formatMoney(entry.principal, money),
                formatMoney(entry.balance, money),
              ]),
            { summary: 'Show amortisation schedule' },
          )
        : null,
    );
  };

  const setPayment = (cents) => {
    payment = Math.max(0, cents);
    paymentInput.value = centsToInput(payment);
    render();
  };

  paymentInput.addEventListener('change', () => setPayment(Math.abs(parseMoney(paymentInput.value))));

  append(
    section,
    sectionHeader('Payoff planner', {
      subtitle: `Balance of ${formatMoney(balance, money)} at ${card.apr ? formatPercent(card.apr, 2) : '0%'} APR`,
    }),
    h(
      'div.payoff-controls',
      null,
      field('Monthly payment', paymentInput, { id: 'payoff-amount' }),
      h(
        'div.preset-row',
        null,
        [
          { label: 'Minimum', value: minimum },
          { label: 'Suggested', value: suggested },
          { label: 'Reserved', value: snap.reserved },
          { label: 'Clear it now', value: balance },
        ]
          .filter((preset) => preset.value > 0)
          .map((preset) =>
            h(
              'button.preset',
              { type: 'button', onclick: () => setPayment(preset.value) },
              h('span.preset-label', { text: preset.label }),
              h('span.preset-value', { text: formatMoney(preset.value, { ...money, cents: false }) }),
            ),
          ),
      ),
    ),
    output,
  );

  render();
  return section;
}
