/**
 * Credit-card maths: balances, utilisation, statement and due dates, minimum
 * payments, interest projections — and, most importantly, *coverage*: how much
 * of the card's balance the budget has actually set aside cash for.
 */

import { addDays, currentMonth, daysBetween, monthOf, nextDayOfMonth, parseISO, todayISO, toISO } from './dates.ts';
import { accountBalance, categoryRow, monthSummary, ledgerTransactions } from './budget.ts';
import { isCredit, paymentCategoryFor } from './model.ts';
import type {
  AppState, Category, Cents, CreditAccount, ISODate, MonthKey,
} from './model.ts';

/** Health of a card's utilisation, carrying a word and an icon, never just a colour. */
export interface UtilizationBand {
  key: 'none' | 'good' | 'watch' | 'elevated' | 'high' | 'over';
  label: string;
  status: 'neutral' | 'good' | 'warning' | 'serious' | 'critical';
  icon: 'info' | 'check' | 'warn' | 'alert';
}

export interface StatementCycle {
  lastClose: ISODate;
  nextClose: ISODate;
  dueDate: ISODate;
  daysUntilDue: number;
  daysUntilClose: number;
  overdue: boolean;
}

/** Everything a card view renders from: account facts plus budget facts. */
export interface CardSnapshot {
  card: CreditAccount;
  paymentCategory: Category | null;
  balance: Cents;
  reserved: Cents;
  /** Debt with no cash set aside for it — the part that accrues interest. */
  uncovered: Cents;
  covered: boolean;
  coverageRatio: number;
  availableCredit: Cents;
  utilization: number | null;
  band: UtilizationBand;
  statementBalance: Cents;
  minimumPayment: Cents;
  cycle: StatementCycle;
  spentThisMonth: Cents;
  paidThisMonth: Cents;
  /** Interest one more month of carrying `uncovered` would cost. */
  monthlyInterestCost: Cents;
}

export interface PayoffInstalment {
  month: number;
  payment: Cents;
  interest: Cents;
  principal: Cents;
  balance: Cents;
}

export interface PayoffResult {
  months: number;
  totalInterest: Cents;
  totalPaid: Cents;
  schedule: PayoffInstalment[];
  neverPaysOff: boolean;
}

export interface PayoffComparison {
  minimum: Cents;
  base: PayoffResult;
  plan: PayoffResult;
  /** Null when either path never clears the balance. */
  monthsSaved: number | null;
  interestSaved: Cents | null;
}

export interface DebtSummary {
  cards: CardSnapshot[];
  balance: Cents;
  limit: Cents;
  reserved: Cents;
  uncovered: Cents;
  minimums: Cents;
  monthlyInterestCost: Cents;
  utilization: number | null;
  band: UtilizationBand;
}

interface SnapshotOptions {
  month?: MonthKey;
  asOf?: ISODate;
}

export const creditAccounts = (
  state: AppState,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): CreditAccount[] =>
  state.accounts.filter((a): a is CreditAccount => isCredit(a) && (includeArchived || !a.archived));

/** Amount owed on a card, returned positive. */
export function cardBalance(state: AppState, cardId: string, throughISO: ISODate | null = null): Cents {
  return -accountBalance(state, cardId, throughISO);
}

export function availableCredit(card: CreditAccount, balanceOwed: Cents): Cents {
  return Math.max(0, (card.creditLimit || 0) - balanceOwed);
}

export function utilization(card: CreditAccount, balanceOwed: Cents): number | null {
  if (!card.creditLimit) return null;
  return balanceOwed / card.creditLimit;
}

/**
 * Utilisation bands. Reported with a label and an icon name as well as a
 * colour, so the state never rides on hue alone.
 */
export function utilizationBand(ratio: number | null, warnAt = 0.3): UtilizationBand {
  if (ratio == null) return { key: 'none', label: 'No limit set', status: 'neutral', icon: 'info' };
  if (ratio >= 1) return { key: 'over', label: 'Over limit', status: 'critical', icon: 'alert' };
  if (ratio >= 0.7) return { key: 'high', label: 'Very high', status: 'critical', icon: 'alert' };
  if (ratio >= 0.5) return { key: 'elevated', label: 'High', status: 'serious', icon: 'warn' };
  if (ratio >= warnAt) return { key: 'watch', label: 'Above target', status: 'warning', icon: 'warn' };
  return { key: 'good', label: 'Healthy', status: 'good', icon: 'check' };
}

export function minimumPayment(card: CreditAccount, balanceOwed: Cents): Cents {
  if (balanceOwed <= 0) return 0;
  const rated = Math.ceil(balanceOwed * (card.minPaymentRate ?? 0.02));
  return Math.min(balanceOwed, Math.max(card.minPaymentFloor ?? 0, rated));
}

/**
 * The statement period that has most recently closed, and the payment due date
 * that belongs to it. `dueDay` is read as "the day of the month after the
 * statement closes", which is how nearly every issuer words it.
 */
export function statementCycle(card: CreditAccount, fromISO: ISODate = todayISO()): StatementCycle {
  const closeDay = Math.min(Math.max(card.statementDay || 1, 1), 31);
  const nextClose = nextDayOfMonth(closeDay, fromISO);
  const previous = parseISO(nextClose);
  previous.setMonth(previous.getMonth() - 1);
  const lastClose = toISO(previous.getFullYear(), previous.getMonth() + 1, previous.getDate());

  const dueDay = Math.min(Math.max(card.dueDay || 21, 1), 31);
  // The due date follows the close date; if the configured day falls on or
  // before the close it belongs to the following month.
  const dueAfterLast = nextDayOfMonth(dueDay, lastClose);
  const dueDate = dueAfterLast === lastClose ? nextDayOfMonth(dueDay, addDays(lastClose, 1)) : dueAfterLast;

  return {
    lastClose,
    nextClose,
    dueDate,
    daysUntilDue: daysBetween(fromISO, dueDate),
    daysUntilClose: daysBetween(fromISO, nextClose),
    overdue: daysBetween(fromISO, dueDate) < 0,
  };
}

/** Balance as of the last statement close — what the issuer actually billed. */
export function statementBalance(state: AppState, card: CreditAccount, fromISO: ISODate = todayISO()): Cents {
  const { lastClose } = statementCycle(card, fromISO);
  return cardBalance(state, card.id, lastClose);
}

/**
 * The full picture for one card, combining account maths with the budget's
 * payment envelope. This is the object every card view renders from.
 */
export function cardSnapshot(
  state: AppState,
  card: CreditAccount,
  { month = currentMonth(), asOf = todayISO() }: SnapshotOptions = {},
): CardSnapshot {
  const balance = cardBalance(state, card.id);
  const summary = monthSummary(state, month);
  const paymentCategory = paymentCategoryFor(state, card.id);
  const row = paymentCategory ? categoryRow(summary, paymentCategory.id) : null;
  const reserved = Math.max(0, row?.available ?? 0);

  const cycle = statementCycle(card, asOf);
  const statement = statementBalance(state, card, asOf);
  const minimum = minimumPayment(card, statement || balance);
  const ratio = utilization(card, balance);

  let spentThisMonth = 0;
  let paidThisMonth = 0;
  for (const tx of ledgerTransactions(state)) {
    if (tx.accountId !== card.id || monthOf(tx.date) !== month) continue;
    if (tx.amount < 0) spentThisMonth += -tx.amount;
    else if (tx.kind === 'transfer') paidThisMonth += tx.amount;
  }

  const uncovered = Math.max(0, balance - reserved);
  return {
    card,
    paymentCategory,
    balance,
    reserved,
    /** Debt with no cash set aside for it — the part that accrues interest. */
    uncovered,
    covered: uncovered === 0,
    coverageRatio: balance > 0 ? Math.min(1, reserved / balance) : 1,
    availableCredit: availableCredit(card, balance),
    utilization: ratio,
    band: utilizationBand(ratio, state.settings?.utilizationWarn ?? 0.3),
    statementBalance: statement,
    minimumPayment: minimum,
    cycle,
    spentThisMonth,
    paidThisMonth,
    /** Interest one more month of carrying `uncovered` would cost. */
    monthlyInterestCost: monthlyInterest(uncovered, card.apr || 0),
  };
}

export function cardSnapshots(state: AppState, opts: SnapshotOptions = {}): CardSnapshot[] {
  return creditAccounts(state).map((card) => cardSnapshot(state, card, opts));
}

export function monthlyInterest(balanceOwed: Cents, apr: number): Cents {
  if (balanceOwed <= 0 || !apr) return 0;
  return Math.round(balanceOwed * (apr / 12));
}

/**
 * Amortise a balance at a fixed monthly payment.
 * Returns `{ months, totalInterest, totalPaid, schedule, neverPaysOff }`.
 * A payment that does not clear the monthly interest is reported honestly as
 * `neverPaysOff` rather than looping forever.
 */
export function payoffSchedule(
  balanceOwed: Cents,
  apr: number,
  monthlyPayment: Cents,
  { maxMonths = 600 }: { maxMonths?: number } = {},
): PayoffResult {
  const empty: PayoffResult = { months: 0, totalInterest: 0, totalPaid: 0, schedule: [], neverPaysOff: false };
  if (balanceOwed <= 0) return empty;
  if (monthlyPayment <= 0) return { ...empty, neverPaysOff: true };

  const rate = (apr || 0) / 12;
  const firstInterest = Math.round(balanceOwed * rate);
  if (monthlyPayment <= firstInterest) {
    return { ...empty, neverPaysOff: true, totalInterest: firstInterest };
  }

  let balance = balanceOwed;
  let totalInterest = 0;
  let totalPaid = 0;
  const schedule: PayoffInstalment[] = [];

  for (let month = 1; month <= maxMonths && balance > 0; month++) {
    const interest = Math.round(balance * rate);
    const payment = Math.min(monthlyPayment, balance + interest);
    const principal = payment - interest;
    balance = Math.max(0, balance - principal);
    totalInterest += interest;
    totalPaid += payment;
    schedule.push({ month, payment, interest, principal, balance });
  }

  return {
    months: schedule.length,
    totalInterest,
    totalPaid,
    schedule,
    neverPaysOff: balance > 0,
  };
}

/** What paying `extra` more each month saves, versus the minimum-only path. */
export function payoffComparison(
  card: CreditAccount,
  balanceOwed: Cents,
  monthlyPayment: Cents,
): PayoffComparison {
  const minimum = minimumPayment(card, balanceOwed);
  const base = payoffSchedule(balanceOwed, card.apr, minimum);
  const plan = payoffSchedule(balanceOwed, card.apr, monthlyPayment);
  return {
    minimum,
    base,
    plan,
    monthsSaved: base.neverPaysOff || plan.neverPaysOff ? null : base.months - plan.months,
    interestSaved: base.neverPaysOff || plan.neverPaysOff ? null : base.totalInterest - plan.totalInterest,
  };
}

/** Cards with a payment due inside `days`, soonest first. */
export function upcomingPayments(
  state: AppState,
  { days = 21, asOf = todayISO() }: { days?: number; asOf?: ISODate } = {},
): CardSnapshot[] {
  return cardSnapshots(state, { asOf })
    .filter((snap) => snap.balance > 0 && snap.cycle.daysUntilDue <= days)
    .sort((a, b) => a.cycle.daysUntilDue - b.cycle.daysUntilDue);
}

/** Portfolio-level totals across every card. */
export function debtSummary(state: AppState, opts: SnapshotOptions = {}): DebtSummary {
  const snaps = cardSnapshots(state, opts);
  const balance = snaps.reduce((total, s) => total + s.balance, 0);
  const limit = snaps.reduce((total, s) => total + (s.card.creditLimit || 0), 0);
  const reserved = snaps.reduce((total, s) => total + s.reserved, 0);
  const uncovered = snaps.reduce((total, s) => total + s.uncovered, 0);
  const monthlyInterestCost = snaps.reduce((total, s) => total + s.monthlyInterestCost, 0);
  const minimums = snaps.reduce((total, s) => total + s.minimumPayment, 0);
  return {
    cards: snaps,
    balance,
    limit,
    reserved,
    uncovered,
    minimums,
    monthlyInterestCost,
    utilization: limit ? balance / limit : null,
    band: utilizationBand(limit ? balance / limit : null, state.settings?.utilizationWarn ?? 0.3),
  };
}
