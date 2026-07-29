/**
 * Reminders: which notifications a budget earns, and on which day.
 *
 * The engine is pure — same state, same day, same list, same ids — which is
 * what lets the delivery layer say "show this once" with nothing but a set of
 * ids to go on. These tests pin that, and the two windows either side of it:
 * a reminder must not fire early, and must not fire so late it is noise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emptyState } from '../src/core/model.ts';
import type { AppState, CreditAccount, ReminderSettings } from '../src/core/model.ts';
import * as actions from '../src/core/actions.ts';
import { account, category, creditAccount, paymentEnvelope } from './helpers.ts';
import { statementCycle } from '../src/core/cards.ts';
import { addDays } from '../src/core/dates.ts';
import {
  REMINDER_GRACE_DAYS, dueReminders, pendingReminders, plannedReminders, reminderSettings,
} from '../src/core/reminders.ts';

const JAN = '2026-01';

/**
 * A card with a $1,200 balance, closing on the 18th and due on the 12th of the
 * following month. Reminders are on by default here; individual tests narrow
 * the settings.
 */
function withCard(reminders: Partial<ReminderSettings> = {}, patch: Partial<CreditAccount> = {}) {
  let state: AppState = emptyState(new Date('2026-01-01T00:00:00Z'));
  state = actions.addAccount(state, {
    name: 'Checking', type: 'checking', openingBalance: 500_000, openedOn: `${JAN}-01`,
  });
  state = actions.addAccount(state, {
    name: 'Visa', type: 'credit', openingBalance: 0, openedOn: `${JAN}-01`,
    creditLimit: 400_000, apr: 0.2199, statementDay: 18, dueDay: 12,
    minPaymentRate: 0.02, minPaymentFloor: 3_500, ...patch,
  });
  state = actions.addCategory(state, { name: 'Groceries', group: 'Everyday' });

  const visa = creditAccount(state, 'Visa');
  const groceries = category(state, 'Groceries');
  state = actions.addTransaction(state, {
    date: `${JAN}-10`, accountId: visa.id, categoryId: groceries.id, amount: -120_000, payee: 'Supermarket',
  });
  state = {
    ...state,
    settings: {
      ...state.settings,
      reminders: { ...state.settings.reminders, enabled: true, ...reminders },
    },
  };

  return { state, checking: account(state, 'Checking'), visa, groceries };
}

/**
 * A card carrying debt that predates the budget: nothing ever funded it, so it
 * is the one balance the app cannot show as covered. (A charge made *inside*
 * the budget funds its own payment envelope — that is the whole idea — so a
 * normal card is covered from the moment it is used.)
 */
function withPreexistingDebt(reminders: Partial<ReminderSettings> = {}) {
  let state: AppState = emptyState(new Date('2026-01-01T00:00:00Z'));
  state = actions.addAccount(state, {
    name: 'Checking', type: 'checking', openingBalance: 500_000, openedOn: `${JAN}-01`,
  });
  state = actions.addAccount(state, {
    name: 'Visa', type: 'credit', openingBalance: -120_000, openedOn: `${JAN}-01`,
    creditLimit: 400_000, apr: 0.2199, statementDay: 18, dueDay: 12,
    minPaymentRate: 0.02, minPaymentFloor: 3_500,
  });
  state = {
    ...state,
    settings: {
      ...state.settings,
      reminders: { ...state.settings.reminders, enabled: true, ...reminders },
    },
  };
  return { state, visa: creditAccount(state, 'Visa') };
}

const ids = (reminders: Array<{ id: string }>): string[] => reminders.map((r) => r.id);
const kinds = (reminders: Array<{ kind: string }>): string[] => reminders.map((r) => r.kind);

test('reminder settings fill in anything an older state is missing', () => {
  const state = emptyState();
  const partial = { ...state, settings: { ...state.settings, reminders: { enabled: true } as ReminderSettings } };
  const settings = reminderSettings(partial);
  assert.equal(settings.enabled, true);
  assert.equal(settings.leadDays, 3, 'falls back to the default lead time');
  assert.equal(settings.payments, true);
});

test('nothing is planned while reminders are switched off', () => {
  const { state } = withCard({ enabled: false });
  assert.deepEqual(plannedReminders(state, { asOf: '2026-02-09' }), []);
});

test('a card with nothing owed earns no reminders', () => {
  let state: AppState = emptyState(new Date('2026-01-01T00:00:00Z'));
  state = actions.addAccount(state, {
    name: 'Visa', type: 'credit', openingBalance: 0, openedOn: `${JAN}-01`,
    creditLimit: 400_000, apr: 0.2199, statementDay: 18, dueDay: 12,
  });
  state = {
    ...state,
    settings: { ...state.settings, reminders: { ...state.settings.reminders, enabled: true, statements: true } },
  };
  assert.deepEqual(plannedReminders(state, { asOf: '2026-02-09' }), []);
});

test('a payment reminder lands `leadDays` before the due date, and again on it', () => {
  const { state, visa } = withCard({ leadDays: 3 });
  const cycle = statementCycle(visa, '2026-02-05');
  assert.equal(cycle.dueDate, '2026-02-12', 'fixture assumption: the 12th of the month after the close');

  const planned = plannedReminders(state, { asOf: '2026-02-05' });
  const fireDays = new Map(planned.map((r) => [r.kind, r.fireOn]));
  assert.equal(fireDays.get('due-soon'), '2026-02-09');
  assert.equal(fireDays.get('due-today'), '2026-02-12');

  // Not a day early…
  assert.deepEqual(kinds(dueReminders(state, { asOf: '2026-02-08' })), []);
  // …and then exactly once, on the day.
  assert.deepEqual(kinds(dueReminders(state, { asOf: '2026-02-09' })), ['due-soon']);
  assert.deepEqual(kinds(dueReminders(state, { asOf: '2026-02-12' })), ['due-today']);
});

test('a lead time of zero leaves only the reminder on the day itself', () => {
  const { state } = withCard({ leadDays: 0 });
  assert.deepEqual(kinds(plannedReminders(state, { asOf: '2026-02-05' })), ['due-today']);
});

test('a delivered id is never offered again', () => {
  const { state } = withCard({ leadDays: 3 });
  const first = dueReminders(state, { asOf: '2026-02-09' });
  assert.equal(first.length, 1);
  assert.deepEqual(dueReminders(state, { asOf: '2026-02-09', delivered: ids(first) }), []);
});

test('ids are stable, so the same reminder is recognised on a later day', () => {
  const { state } = withCard({ leadDays: 3 });
  const [planned] = plannedReminders(state, { asOf: '2026-02-01' });
  const [again] = plannedReminders(state, { asOf: '2026-02-09' });
  assert.ok(planned && again);
  assert.equal(planned.id, again.id);
});

test('a reminder is delivered late within the grace window, and dropped after it', () => {
  const { state } = withCard({ leadDays: 3 });
  // Planned for the 9th: still worth saying on the 11th…
  assert.deepEqual(kinds(dueReminders(state, { asOf: addDays('2026-02-09', REMINDER_GRACE_DAYS) })), ['due-soon']);
  // …but by the 12th it is the due date itself, and the stale nudge is dropped
  // rather than piling up behind the reminder that replaced it.
  assert.deepEqual(kinds(dueReminders(state, { asOf: '2026-02-12' })), ['due-today']);
});

test('an overdue payment repeats, so one is always fresh enough to fire', () => {
  // Past the 12th but before the next close on the 18th: the bill is late.
  const { state } = withCard();
  const overdue = plannedReminders(state, { asOf: '2026-02-13' }).filter((r) => r.kind === 'overdue');
  assert.ok(overdue.length > 1, 'repeats rather than nagging once');
  assert.ok(overdue.every((r) => r.urgent), 'an overdue bill is worth interrupting for');

  // Whenever the app is opened while the bill is late, exactly one is waiting:
  // the repeats are spaced to the grace window, so they neither gap nor stack.
  // (The 18th is the next close, which is as long as this cycle can stay late.)
  for (let days = 1; days <= 6; days++) {
    const asOf = addDays('2026-02-12', days);
    assert.equal(
      dueReminders(state, { asOf }).filter((r) => r.kind === 'overdue').length,
      1,
      `exactly one overdue reminder ${days} days late`,
    );
  }
});

test('once the next statement closes, the overdue nag gives way to the new cycle', () => {
  const { state } = withCard({ leadDays: 3 });
  const planned = plannedReminders(state, { asOf: '2026-02-19' });
  assert.ok(!kinds(planned).includes('overdue'), 'the missed payment is now part of the new statement');
  assert.deepEqual(
    planned.map((r) => r.fireOn),
    ['2026-03-09', '2026-03-12'],
    'reminders point at the next due date instead',
  );
});

test('an overdue card is not also told its payment is coming up', () => {
  const { state } = withCard();
  assert.deepEqual(new Set(kinds(plannedReminders(state, { asOf: '2026-02-13' }))), new Set(['overdue']));
});

test('the unfunded warning fires on the closing date, and only while cover is short', () => {
  const { state, visa } = withPreexistingDebt({ payments: false, unfunded: true });

  const planned = plannedReminders(state, { asOf: '2026-02-05' });
  assert.deepEqual(kinds(planned), ['unfunded']);
  assert.equal(planned[0]?.fireOn, statementCycle(visa, '2026-02-05').nextClose);
  assert.match(planned[0]?.title ?? '', /1,200\.00/, 'says how much is uncovered');

  // Fund the payment envelope in full and the warning has nothing to say.
  const envelope = paymentEnvelope(state, visa.id);
  const funded = actions.setBudget(state, '2026-02', envelope.id, 120_000);
  assert.deepEqual(plannedReminders(funded, { asOf: '2026-02-05' }), []);
});

test('payment reminders say whether the budget has the bill covered', () => {
  // Spending on a card funds its payment envelope as it happens, so an ordinary
  // charge is already covered by the time the bill arrives.
  const [covered] = plannedReminders(withCard({ leadDays: 3 }).state, { asOf: '2026-02-05' });
  assert.match(covered?.body ?? '', /covers it in full/);

  const short = plannedReminders(withPreexistingDebt({ leadDays: 3 }).state, { asOf: '2026-02-05' })
    .find((reminder) => reminder.kind === 'due-soon');
  assert.match(short?.body ?? '', /not funded yet/);
});

test('statement reminders are opt-in and land on the closing day', () => {
  const { state, visa } = withCard({ payments: false, unfunded: false, statements: true });
  const planned = plannedReminders(state, { asOf: '2026-02-05' });
  assert.deepEqual(kinds(planned), ['statement']);
  assert.equal(planned[0]?.fireOn, statementCycle(visa, '2026-02-05').nextClose);
});

test('every reminder carries a route into the card it is about', () => {
  const { state, visa } = withCard({ statements: true });
  for (const reminder of plannedReminders(state, { asOf: '2026-02-05' })) {
    assert.equal(reminder.route, `#/cards/${visa.id}`);
    assert.ok(reminder.title, 'has a title');
    assert.ok(reminder.body, 'has a body');
  }
});

test('planning stops at the horizon, and the preview keeps what is still ahead', () => {
  const { state } = withCard({ leadDays: 3, statements: true });
  assert.deepEqual(plannedReminders(state, { asOf: '2026-02-05', horizonDays: 5 }).map((r) => r.kind), [
    'due-soon',
  ]);

  const preview = pendingReminders(state, { asOf: '2026-02-05' });
  assert.ok(preview.length >= 2);
  assert.deepEqual(
    preview.map((r) => r.fireOn),
    [...preview.map((r) => r.fireOn)].sort(),
    'soonest first',
  );
});

test('two cards each get their own reminders', () => {
  const { state, groceries } = withCard({ leadDays: 3 });
  let twoCards = actions.addAccount(state, {
    name: 'Mastercard', type: 'credit', openingBalance: 0, openedOn: `${JAN}-01`,
    creditLimit: 200_000, apr: 0.24, statementDay: 18, dueDay: 12,
  });
  const second = creditAccount(twoCards, 'Mastercard');
  twoCards = actions.addTransaction(twoCards, {
    date: `${JAN}-11`, accountId: second.id, categoryId: groceries.id, amount: -40_000, payee: 'Fuel',
  });

  const due = dueReminders(twoCards, { asOf: '2026-02-09' });
  assert.equal(due.length, 2);
  assert.equal(new Set(due.map((r) => r.subjectId)).size, 2, 'one per card, not one for both');
});
