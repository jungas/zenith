/**
 * Reminders: what is worth saying about a budget, and on which day to say it.
 *
 * Pure and DOM-free like the rest of `core/`. This module only decides *what*
 * the notifications are; asking for permission, drawing them, remembering what
 * has already been shown and waking the service worker all live in
 * `src/reminders.ts`.
 *
 * Every reminder is derived from the budget itself, so nothing is stored: the
 * same state on the same day always produces the same list, with the same ids.
 * That is what makes "show this once" possible without a queue — the id is the
 * receipt.
 */

import { cardSnapshots } from './cards.ts';
import { addDays, daysBetween, formatDate, monthOf, todayISO } from './dates.ts';
import { formatMoney } from './money.ts';
import { REMINDER_DEFAULTS } from './model.ts';
import type { AppState, ISODate, MoneyOptions, ReminderSettings } from './model.ts';
import type { CardSnapshot } from './cards.ts';

export type ReminderKind = 'due-soon' | 'due-today' | 'overdue' | 'statement' | 'unfunded';

export interface Reminder {
  /**
   * Stable across regenerations, and unique to one occasion — this is what
   * stops a reminder being shown twice, and what a notification's tag carries.
   */
  id: string;
  kind: ReminderKind;
  cardId: string;
  cardName: string;
  /** The calendar day it should be delivered on. */
  fireOn: ISODate;
  title: string;
  body: string;
  /** Where tapping it should land. */
  route: string;
  /** Worth interrupting for: an overdue bill, not a statement closing. */
  urgent: boolean;
}

export interface PlanOptions {
  asOf?: ISODate;
  /** How far ahead to plan. One billing cycle covers every reminder a card has. */
  horizonDays?: number;
}

export interface DueOptions {
  asOf?: ISODate;
  delivered?: Iterable<string>;
  graceDays?: number;
}

/**
 * How late a reminder may be delivered. A phone that was off, or an app that
 * was not opened, should still say "your bill is due" the next morning — but a
 * week later the moment has passed and saying it then is just noise.
 */
export const REMINDER_GRACE_DAYS = 2;

/**
 * An overdue bill is repeated rather than said once, because being late is a
 * state rather than a moment — whenever you next open the app, it should say so.
 *
 * The spacing is the grace window plus a day on purpose: each repeat then
 * covers exactly the days since the last one, so there is no gap where a card
 * is overdue and nothing fires, and no day where two repeats fire together.
 * It stops after three weeks; by then the message has been received or it never
 * will be.
 */
const OVERDUE_REPEAT_DAYS = REMINDER_GRACE_DAYS + 1;
const OVERDUE_REPEATS = 7;

/** Settings with any missing flag filled in, for state written by older versions. */
export function reminderSettings(state: AppState): ReminderSettings {
  return { ...REMINDER_DEFAULTS, ...(state.settings?.reminders ?? {}) };
}

/**
 * Every reminder the budget currently implies, soonest first.
 *
 * Reminders are planned one billing cycle ahead: that covers the next due date
 * and the next statement close, which is as far as the figures can be trusted.
 * A device that goes a full cycle without opening Zenith gets that cycle's
 * reminders and then falls silent until it is opened again.
 */
export function plannedReminders(
  state: AppState,
  { asOf = todayISO(), horizonDays = 45 }: PlanOptions = {},
): Reminder[] {
  const settings = reminderSettings(state);
  if (!settings.enabled) return [];

  const money: MoneyOptions = {
    currency: state.settings.currency,
    locale: state.settings.locale,
  };
  const locale = state.settings.locale;
  const out: Reminder[] = [];

  // Coverage is a budget fact, so it is read for the month `asOf` falls in
  // rather than whichever month the device happens to be in.
  for (const snap of cardSnapshots(state, { asOf, month: monthOf(asOf) })) {
    // Nothing owed is nothing to be reminded about — including the statement
    // close, which is only interesting when it will bill you for something.
    if (snap.balance <= 0) continue;
    out.push(...cardReminders(snap, settings, money, locale));
  }

  return out
    .filter((reminder) => daysBetween(asOf, reminder.fireOn) <= horizonDays)
    .sort((a, b) => (a.fireOn < b.fireOn ? -1 : a.fireOn > b.fireOn ? 1 : a.id.localeCompare(b.id)));
}

function cardReminders(
  snap: CardSnapshot,
  settings: ReminderSettings,
  money: MoneyOptions,
  locale: string,
): Reminder[] {
  const { card, cycle } = snap;
  const out: Reminder[] = [];
  const route = `#/cards/${card.id}`;
  const owed = snap.statementBalance || snap.balance;
  // Dates are absolute rather than "in 3 days", because a reminder can be
  // delivered a day or two after it was planned for and must still be true.
  const dueLabel = formatDate(cycle.dueDate, locale, { weekday: 'short', month: 'short', day: 'numeric' });
  const amounts = `${formatMoney(owed, money)} on the statement, minimum ${formatMoney(snap.minimumPayment, money)}.`;
  const coverage = snap.covered
    ? 'Your budget covers it in full.'
    : `${formatMoney(snap.uncovered, money)} of it is not funded yet.`;

  if (settings.payments && cycle.overdue) {
    // Repeated weekly, which also means one is always recent enough to survive
    // the grace window however long the app has been closed.
    for (let repeat = 0; repeat < OVERDUE_REPEATS; repeat++) {
      out.push({
        id: `overdue:${card.id}:${cycle.dueDate}:${repeat}`,
        kind: 'overdue',
        cardId: card.id,
        cardName: card.name,
        fireOn: addDays(cycle.dueDate, 1 + repeat * OVERDUE_REPEAT_DAYS),
        title: `${card.name} payment is overdue`,
        body: `It was due ${dueLabel}. ${amounts}`,
        route,
        urgent: true,
      });
    }
  } else if (settings.payments) {
    if (settings.leadDays > 0) {
      out.push({
        id: `due-soon:${card.id}:${cycle.dueDate}`,
        kind: 'due-soon',
        cardId: card.id,
        cardName: card.name,
        fireOn: addDays(cycle.dueDate, -settings.leadDays),
        title: `${card.name} payment due ${dueLabel}`,
        body: `${amounts} ${coverage}`,
        route,
        urgent: false,
      });
    }
    out.push({
      id: `due-today:${card.id}:${cycle.dueDate}`,
      kind: 'due-today',
      cardId: card.id,
      cardName: card.name,
      fireOn: cycle.dueDate,
      title: `${card.name} payment due today`,
      body: `${amounts} ${coverage}`,
      route,
      urgent: true,
    });
  }

  if (settings.statements) {
    out.push({
      id: `statement:${card.id}:${cycle.nextClose}`,
      kind: 'statement',
      cardId: card.id,
      cardName: card.name,
      fireOn: cycle.nextClose,
      title: `${card.name} statement closes today`,
      body: `Anything charged after today lands on the next statement. ${formatMoney(snap.balance, money)} owed so far.`,
      route,
      urgent: false,
    });
  }

  // Fired on the close date: that is the moment the amount stops moving, so it
  // is the last useful point to notice the budget has not covered it.
  if (settings.unfunded && snap.uncovered > 0) {
    out.push({
      id: `unfunded:${card.id}:${cycle.nextClose}`,
      kind: 'unfunded',
      cardId: card.id,
      cardName: card.name,
      fireOn: cycle.nextClose,
      title: `${formatMoney(snap.uncovered, money)} of ${card.name} is not funded`,
      body: `Its statement closes today and that part of the balance has no cash set aside — it is what will accrue interest. Assign money to its payment envelope to cover it.`,
      route,
      urgent: false,
    });
  }

  return out;
}

/**
 * The reminders that should be shown right now: planned for today or the last
 * couple of days, and not already delivered.
 */
export function dueReminders(
  state: AppState,
  { asOf = todayISO(), delivered = [], graceDays = REMINDER_GRACE_DAYS }: DueOptions = {},
): Reminder[] {
  const seen = new Set(delivered);
  return plannedReminders(state, { asOf }).filter((reminder) => {
    if (seen.has(reminder.id)) return false;
    const offset = daysBetween(asOf, reminder.fireOn);
    return offset <= 0 && offset >= -graceDays;
  });
}

/** Reminders still ahead (or just missed) — what Settings previews. */
export function pendingReminders(
  state: AppState,
  { asOf = todayISO(), graceDays = REMINDER_GRACE_DAYS }: DueOptions = {},
): Reminder[] {
  return plannedReminders(state, { asOf }).filter(
    (reminder) => daysBetween(asOf, reminder.fireOn) >= -graceDays,
  );
}
