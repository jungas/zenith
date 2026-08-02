/**
 * Bills — what is committed before any of it is spent.
 *
 * The view leads with the two figures a schedule is actually for: what is still
 * to leave this month, and how much of that has money behind it. A bill with a
 * date and no envelope is the thing worth catching, and it is only catchable
 * before the date arrives.
 */

import { h, append } from '../ui/dom.ts';
import { icon } from '../ui/icons.ts';
import { statTile, statusPill, sectionHeader, emptyState } from '../ui/components.ts';
import { openBillForm, openLinkTransactionForm, openPayBillForm } from '../ui/forms.ts';
import { formatMoney } from '../core/money.ts';
import { addMonths, currentMonth, formatDateShort, monthLabel, relativeDays } from '../core/dates.ts';
import { navigate } from '../router.ts';
import { billFunding, billTotals, suggestedBills, upcomingBills } from '../core/bills.ts';
import { BILL_CADENCES } from '../core/model.ts';
import type { BillFunding, BillOccurrence, BillSnapshot, BillStatus } from '../core/bills.ts';
import { commit, getState, moneyOpts, undo } from '../store.ts';
import * as actions from '../core/actions.ts';
import { toast } from '../ui/toast.ts';
import type { Bill, MonthKey, MoneyOptions } from '../core/model.ts';
import type { Tone } from '../ui/components.ts';

type Money = Required<Pick<MoneyOptions, 'currency' | 'locale'>>;

/** Status decides the words and the icon; colour never carries it alone. */
const STATUS: Record<BillStatus, { tone: Tone; label: string }> = {
  overdue: { tone: 'critical', label: 'Past due' },
  'due-today': { tone: 'serious', label: 'Due today' },
  'due-soon': { tone: 'warning', label: 'Due soon' },
  upcoming: { tone: 'neutral', label: 'Upcoming' },
  paid: { tone: 'good', label: 'Paid' },
  skipped: { tone: 'neutral', label: 'Skipped' },
  ended: { tone: 'neutral', label: 'Finished' },
};

export function billsView({ month = currentMonth() }: { month?: MonthKey } = {}): HTMLElement {
  const state = getState();
  const money = moneyOpts(state);
  const root = h('div.view.view-bills');

  const addButton = h(
    'button.btn.btn-primary',
    { type: 'button', onclick: () => openBillForm() },
    icon('plus', { size: 16 }),
    h('span', { text: 'Track a bill' }),
  );

  if (!(state.bills ?? []).length) {
    append(
      root,
      emptyState({
        title: 'No bills tracked yet',
        message:
          'A tracked bill says when money is due to leave and what it will cost, so the month is decided before it starts. Nothing is recorded until you pay one.',
        iconName: 'repeat',
        action: addButton,
      }),
      suggestionsBlock(money),
    );
    return root;
  }

  const totals = billTotals(state, { month });
  const funding = billFunding(state, { month });

  /* Which month the figures are about. The schedule itself runs either way, so
     last month answers "did I pay it?" as readily as next month answers
     "what is coming?". */
  append(
    root,
    h(
      'div.month-nav.month-bar',
      null,
      h(
        'button.icon-btn',
        {
          type: 'button',
          'aria-label': 'Previous month',
          onclick: () => navigate(`#/bills/${addMonths(month, -1)}`),
        },
        icon('arrowLeft', { size: 18 }),
      ),
      h('span.month-label', { text: monthLabel(month, money.locale) }),
      h(
        'button.icon-btn',
        {
          type: 'button',
          'aria-label': 'Next month',
          onclick: () => navigate(`#/bills/${addMonths(month, 1)}`),
        },
        icon('arrowRight', { size: 18 }),
      ),
      month !== currentMonth()
        ? h('button.btn.btn-sm.btn-ghost', {
            type: 'button',
            text: 'Today',
            onclick: () => navigate(`#/bills/${currentMonth()}`),
          })
        : null,
    ),
  );

  /* Hero: what is still to leave this month. */
  const tone = funding.uncovered > 0 ? 'critical' : totals.unpaidThisMonth > 0 ? 'accent' : 'good';
  append(
    root,
    h(
      'section.hero',
      null,
      h(
        'div.hero-main',
        null,
        // The month is named by the switcher directly above, so it is not
        // repeated here.
        h('p.hero-label', { text: 'Still to pay' }),
        h('p', { class: `hero-figure tone-${tone}`, text: formatMoney(totals.unpaidThisMonth, money) }),
        h(
          'p.hero-note',
          null,
          totals.overdue > 0
            ? statusPill('critical', `${totals.overdue} past due`)
            : funding.uncovered > 0
              ? statusPill('warning', `${formatMoney(funding.uncovered, money)} not funded yet`)
              : totals.unpaidThisMonth > 0
                ? statusPill('good', 'Every bill left this month is funded')
                : statusPill('good', 'Every bill this month is settled'),
        ),
      ),
      h('div.hero-actions', null, addButton),
    ),
  );

  /* Stat tiles. */
  append(
    root,
    h(
      'div.tile-grid',
      null,
      statTile({
        label: 'Billed this month',
        value: formatMoney(totals.dueThisMonth, { ...money, cents: false }),
        hint: `${formatMoney(totals.paidThisMonth, { ...money, cents: false })} already paid`,
      }),
      statTile({
        label: 'Monthly commitment',
        value: formatMoney(totals.monthlyCommitment, { ...money, cents: false }),
        hint: 'Every bill spread to a monthly figure',
      }),
      statTile({
        label: 'Not yet funded',
        value: formatMoney(funding.uncovered, { ...money, cents: false }),
        hint:
          funding.uncovered > 0
            ? `${funding.unfundedCount} envelope${funding.unfundedCount === 1 ? '' : 's'} short`
            : 'Every envelope covers what it owes',
        tone: funding.uncovered > 0 ? 'critical' : 'good',
      }),
      statTile({
        label: 'Bills tracked',
        value: String(totals.bills.length),
        hint: totals.overdue ? `${totals.overdue} past due` : 'All on schedule',
        tone: totals.overdue ? 'critical' : 'neutral',
      }),
    ),
  );

  /* The funding gap, with the one-click fix beside it. */
  if (funding.uncovered > 0) {
    append(root, fundingCallout(funding, month, money));
  }

  /* What is coming. */
  const due = upcomingBills(state, { days: 45, month });
  if (due.length) {
    append(
      root,
      h(
        'section.block',
        null,
        sectionHeader('Coming up', { subtitle: 'Next 45 days, and anything already past due' }),
        h(
          'ul.due-list',
          { role: 'list' },
          due.flatMap((snapshot) => (snapshot.next ? [dueRow(snapshot, snapshot.next, money)] : [])),
        ),
      ),
    );
  }

  /* Every bill, whether or not it is due. */
  append(
    root,
    h(
      'section.block',
      null,
      sectionHeader('All bills', {
        subtitle: 'What each one costs, and when it comes round',
      }),
      h('ul.bill-list', { role: 'list' }, totals.bills.map((snapshot) => billRow(snapshot, money))),
    ),
  );

  append(root, suggestionsBlock(money));
  return root;
}

function fundingCallout(funding: BillFunding, month: MonthKey, money: Money): HTMLElement {
  const worst = funding.rows.filter((row) => row.uncovered > 0);
  const names = worst
    .map((row) => row.category?.name ?? 'bills with no envelope')
    .slice(0, 3)
    .join(', ');

  return h(
    'section',
    { class: 'callout callout-warning' },
    h('div.callout-icon', null, icon('warn', { size: 20 })),
    h(
      'div.callout-body',
      null,
      h('h3.callout-title', {
        text: `${formatMoney(funding.uncovered, money)} of this month's bills has no money behind it`,
      }),
      h('p.callout-text', {
        text: `${names} ${worst.length === 1 ? 'does' : 'do'} not hold enough to cover what is still due. Assigning it now is the difference between a bill you have planned for and one that overspends its envelope.`,
      }),
    ),
    // Only offered where there is something to assign — otherwise the honest
    // answer is that the money is not there yet, not that a button failed.
    h('button.btn.btn-primary', {
      type: 'button',
      text: 'Assign what they need',
      onclick: () => {
        const before = funding.uncovered;
        commit((s) => actions.assignForBills(s, month), { label: 'fund bills' });
        const after = billFunding(getState(), { month }).uncovered;
        if (after === before) {
          toast('There is nothing left to assign this month.', { tone: 'warning' });
          return;
        }
        toast(
          after > 0
            ? `${formatMoney(before - after, money)} assigned — ${formatMoney(after, money)} still short.`
            : 'Every bill this month is funded.',
          { tone: 'success', action: { label: 'Undo', onClick: () => undo() } },
        );
      },
    }),
  );
}

/** A row in "Coming up": one bill, its next unsettled occurrence. */
function dueRow(snapshot: BillSnapshot, next: BillOccurrence, money: Money): HTMLElement {
  const { bill } = snapshot;
  const status = STATUS[next.status];

  return h(
    'li.due-row',
    null,
    h('div.due-icon', null, icon('repeat', { size: 18 })),
    h(
      'div.due-main',
      null,
      h('p.due-name', { text: bill.name }),
      h('p.due-meta', {
        text:
          `${formatDateShort(next.dueDate, money.locale)} · ${relativeDays(next.daysUntilDue)}` +
          (snapshot.category ? ` · ${snapshot.category.name}` : ''),
      }),
    ),
    h(
      'div.due-figures',
      null,
      h('p.due-amount', { text: formatMoney(next.amount, money) }),
      h('p.due-min', {
        text: bill.variable ? 'estimated' : (BILL_CADENCES[bill.cadence] ?? BILL_CADENCES.monthly).label.toLowerCase(),
      }),
    ),
    h(
      'div.due-status',
      null,
      statusPill(status.tone, bill.autopay ? 'Automatic' : status.label, { size: 'sm' }),
    ),
    h(
      'div.due-actions',
      null,
      // An automatic payment still needs recording once it has actually gone
      // out, so the button stays — it just does not claim to be doing the
      // paying.
      h('button.btn.btn-sm.btn-primary', {
        type: 'button',
        text: bill.autopay ? 'Record' : 'Pay',
        onclick: () => openPayBillForm(bill.id, next.dueDate),
      }),
      h('button.btn.btn-sm.btn-ghost', {
        type: 'button',
        text: 'Link…',
        title: 'Point an existing transaction at this bill instead of recording a new one',
        onclick: () => openLinkTransactionForm(bill.id, next.dueDate),
      }),
    ),
  );
}

/** A row in "All bills": the schedule itself, with this month's occurrences. */
function billRow(snapshot: BillSnapshot, money: Money): HTMLElement {
  const { bill } = snapshot;
  const spec = BILL_CADENCES[bill.cadence] ?? BILL_CADENCES.monthly;
  const status = STATUS[snapshot.status];

  return h(
    'li.bill-row',
    null,
    h(
      'div.bill-head',
      null,
      h('span.bill-name', { text: bill.name }),
      h('span.bill-amount', {
        text: bill.variable
          ? `~${formatMoney(snapshot.expected, money)}`
          : formatMoney(bill.amount, money),
      }),
      h(
        'div.bill-actions',
        null,
        h(
          'button.icon-btn',
          {
            type: 'button',
            'aria-label': `Edit ${bill.name}`,
            title: 'Edit this bill',
            onclick: () => openBillForm({ bill }),
          },
          icon('edit', { size: 16 }),
        ),
      ),
    ),
    h(
      'p.bill-meta',
      null,
      statusPill(status.tone, status.label, { size: 'sm' }),
      h('span', {
        text:
          `${spec.label} · ${
            snapshot.next
              ? `next ${formatDateShort(snapshot.next.dueDate, money.locale)}`
              : 'no further dates'
          }` +
          (snapshot.category ? ` · ${snapshot.category.name}` : ' · no envelope') +
          (bill.cadence === 'monthly' ? '' : ` · ${formatMoney(snapshot.monthlyEquivalent, money)}/mo`),
      }),
      bill.autopay ? h('span.chip.chip-quiet', { text: 'Automatic' }) : null,
    ),
    snapshot.thisMonth.length
      ? h(
          'ul.bill-occurrences',
          { role: 'list' },
          snapshot.thisMonth.map((entry) => occurrenceChip(bill, entry, money)),
        )
      : null,
  );
}

/**
 * One occurrence of one bill in the month on screen.
 *
 * Paid occurrences are shown, not hidden: "paid on the 5th" is the answer to
 * the question this view is opened with as often as "due on the 5th" is.
 */
function occurrenceChip(bill: Bill, entry: BillOccurrence, money: Money): HTMLElement {
  const status = STATUS[entry.status];
  const label = `${formatDateShort(entry.dueDate, money.locale)} · ${formatMoney(entry.amount, money)}`;

  if (entry.paid) {
    const paidTransactionId = entry.paid.id;
    return h(
      'li.bill-occurrence.is-paid',
      null,
      icon('check', { size: 14 }),
      h('span', { text: `${label} · paid` }),
      h('button.link-btn', {
        type: 'button',
        text: 'Unlink',
        title: 'Detach this transaction from the bill, without touching the money',
        onclick: () => {
          commit((s) => actions.unlinkBillPayment(s, paidTransactionId), { label: 'unlink bill payment' });
        },
      }),
    );
  }
  if (entry.skipped) {
    return h(
      'li.bill-occurrence.is-skipped',
      null,
      h('span', { text: `${label} · skipped` }),
      h('button.link-btn', {
        type: 'button',
        text: 'Undo',
        onclick: () => {
          commit((s) => actions.unskipBillOccurrence(s, bill.id, entry.dueDate), { label: 'unskip bill' });
        },
      }),
    );
  }
  return h(
    'li',
    { class: `bill-occurrence tone-${status.tone}` },
    h('span', { text: label }),
    h('button.link-btn', {
      type: 'button',
      text: bill.autopay ? 'Record' : 'Pay',
      onclick: () => openPayBillForm(bill.id, entry.dueDate),
    }),
    h('button.link-btn', {
      type: 'button',
      text: 'Link…',
      title: 'Point an existing transaction at this bill instead of recording a new one',
      onclick: () => openLinkTransactionForm(bill.id, entry.dueDate),
    }),
  );
}

/**
 * Payees that already look like bills.
 *
 * Offered, never created: three payments to the same payee a month apart is a
 * strong hint and a weak fact, so the figures are filled in and the decision
 * stays with the person who knows whether it is really a commitment.
 */
function suggestionsBlock(money: Money): HTMLElement | null {
  const drafts = suggestedBills(getState());
  if (!drafts.length) return null;

  return h(
    'section.block',
    null,
    sectionHeader('Looks like a bill', {
      subtitle: 'You have paid these on a regular rhythm — track one and it joins the schedule above.',
    }),
    h(
      'ul.suggestion-list',
      { role: 'list' },
      drafts.map((draft) =>
        h(
          'li.suggestion-row',
          null,
          h(
            'div.suggestion-main',
            null,
            h('p.suggestion-name', { text: draft.name ?? '' }),
            h('p.suggestion-meta', {
              text: `${(BILL_CADENCES[draft.cadence ?? 'monthly'] ?? BILL_CADENCES.monthly).label} · about ${formatMoney(draft.amount ?? 0, money)}`,
            }),
          ),
          h('button.btn.btn-sm', {
            type: 'button',
            text: 'Track it',
            onclick: () => openBillForm({ draft }),
          }),
        ),
      ),
    ),
  );
}
