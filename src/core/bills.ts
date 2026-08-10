/**
 * Recurring bills: when money is next expected to leave, and whether the budget
 * is ready for it.
 *
 * Two things are **derived** here rather than stored, and both for the same
 * reason instalment plans derive their progress: anything a person has to
 * advance by hand is wrong the moment they forget.
 *
 *   · **The schedule.** A bill holds one real due date and a cadence. Every
 *     other occurrence — past or future — is that anchor stepped forwards or
 *     back, so nothing rolls over at the end of a month and a bill added today
 *     can still say what it did in March.
 *
 *   · **What has been paid.** An occurrence is settled when a transaction in
 *     the ledger carries this bill's id and that occurrence's due date. Nothing
 *     is marked paid in the bill itself, so deleting the payment un-pays the
 *     month, editing it re-prices the month, and the account balances are the
 *     only record of money that actually moved.
 *
 * The one thing a bill *does* store beyond its terms is which occurrences were
 * deliberately skipped — because "nobody paid this and nobody was going to" is
 * a fact about intent that the ledger cannot hold.
 *
 * Pure and DOM-free like the rest of `core/`.
 */

import { categoryRow, monthSummary } from './budget.ts';
import {
  addDays, addMonthsToDate, currentMonth, daysBetween, daysInMonth, monthOf, todayISO,
} from './dates.ts';
import { BILL_CADENCES, sameName } from './model.ts';
import type {
  Account, AppState, Bill, Category, Cents, ISODate, MonthKey, Transaction,
} from './model.ts';

export type BillStatus =
  | 'paid'
  | 'skipped'
  | 'overdue'
  | 'due-today'
  | 'due-soon'
  | 'upcoming'
  /** No occurrence left: the bill has run past its end date. */
  | 'ended';

/** One due date of one bill, with whatever the ledger says about it. */
export interface BillOccurrence {
  bill: Bill;
  dueDate: ISODate;
  /**
   * What it cost, or is expected to. A settled occurrence reports the payment
   * actually recorded — that is the honest figure, whatever the bill says it
   * should have been.
   */
  amount: Cents;
  /** The transaction that settled it, if any. */
  paid: Transaction | null;
  skipped: boolean;
  status: BillStatus;
  /** Negative once the due date has passed. */
  daysUntilDue: number;
}

export interface BillSnapshot {
  bill: Bill;
  category: Category | null;
  account: Account | null;
  /**
   * The occurrence that wants attention: the oldest one still unsettled, which
   * is an overdue bill when there is one and the next due date otherwise.
   */
  next: BillOccurrence | null;
  /** The next occurrence's status, or 'ended' when the schedule has run out. */
  status: BillStatus;
  daysUntilDue: number;
  /** What the next occurrence is expected to cost. */
  expected: Cents;
  /** The most recent payment recorded against this bill. */
  lastPaid: Transaction | null;
  /** Every occurrence falling in the month asked about. */
  thisMonth: BillOccurrence[];
  /** Still to be paid this month. */
  dueThisMonth: Cents;
  paidThisMonth: Cents;
  /** What this bill works out to per month, whatever its cadence. */
  monthlyEquivalent: Cents;
}

export interface BillTotals {
  bills: BillSnapshot[];
  /** Every unsettled occurrence in the month, soonest first. */
  outstanding: BillOccurrence[];
  /** Billed in this month, paid or not. */
  dueThisMonth: Cents;
  paidThisMonth: Cents;
  /** Still to leave this month. */
  unpaidThisMonth: Cents;
  overdue: number;
  /** Every bill's monthly equivalent, added up: the standing commitment. */
  monthlyCommitment: Cents;
}

/** One envelope's standing against the bills it is expected to pay. */
export interface BillFundingRow {
  categoryId: string | null;
  category: Category | null;
  /** Unpaid bills due this month in this envelope. */
  due: Cents;
  /** What the envelope holds. */
  available: Cents;
  /** The part of `due` with no money behind it. */
  uncovered: Cents;
  /** The soonest unpaid due date, which is what orders any funding. */
  soonest: ISODate | null;
}

export interface BillFunding {
  rows: BillFundingRow[];
  due: Cents;
  uncovered: Cents;
  /** Bills whose envelope cannot cover them yet. */
  unfundedCount: number;
}

export interface BillOptions {
  asOf?: ISODate;
  month?: MonthKey;
}

/** A bill within a week is "due soon" — the same horizon the card views use. */
export const BILL_DUE_SOON_DAYS = 7;

/**
 * How far back an unpaid occurrence is still chased.
 *
 * Beyond two months an unpaid bill is not a bill that is late; it is one that
 * was settled outside Zenith, or never existed. Chasing it forever would pin
 * every snapshot to the oldest thing the schedule ever generated.
 */
export const BILL_OVERDUE_LOOKBACK_DAYS = 62;

/** How far ahead the schedule is generated when looking for the next due date. */
const HORIZON_DAYS = 400;

/** Enough for a weekly bill across the lookback plus the horizon, and no more. */
const MAX_OCCURRENCES = 500;

/** Payments already recorded, keyed by bill and the occurrence they settled. */
type PaymentIndex = Map<string, Transaction>;

const paymentKey = (billId: string, dueDate: ISODate): string => `${billId}|${dueDate}`;

/**
 * Index the ledger once per pass.
 *
 * Every occurrence of every bill asks "was this one paid?", which is a scan of
 * the transaction list each time. Building the answer once turns a quadratic
 * walk into a lookup.
 */
export function billPayments(state: AppState): PaymentIndex {
  const index: PaymentIndex = new Map();
  for (const tx of state.transactions) {
    if (!tx.billId || !tx.billDue) continue;
    const key = paymentKey(tx.billId, tx.billDue);
    // Two payments against one occurrence: the later one is the record, so the
    // bill reads the way the account does.
    const existing = index.get(key);
    if (!existing || tx.date > existing.date) index.set(key, tx);
  }
  return index;
}

export const billById = (state: AppState, billId: string | null | undefined): Bill | null =>
  (billId && (state.bills ?? []).find((bill) => bill.id === billId)) || null;

/**
 * Is another bill already tracked under this name?
 *
 * Archived bills still count — they stay in the same list a moment away from
 * being unarchived, and "Electricity" twice is exactly the confusion a
 * duplicate check exists to head off.
 */
export function billNameTaken(
  state: AppState,
  name: string,
  { excludeId }: { excludeId?: string } = {},
): boolean {
  return (state.bills ?? []).some((b) => b.id !== excludeId && sameName(b.name, name));
}

export function activeBills(
  state: AppState,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Bill[] {
  return (state.bills ?? []).filter((bill) => includeArchived || !bill.archived);
}

/* ── The schedule ─────────────────────────────────────────────────────── */

/**
 * The `index`-th occurrence, counting from the anchor.
 *
 * The schedule **starts** at the anchor: nothing is generated before it, even
 * though the arithmetic would happily run backwards. A bill entered with its
 * next due date would otherwise sprout a history of dates nobody was ever
 * billed for, every one of them reading as missed.
 */
export function occurrenceAt(bill: Bill, index: number): ISODate {
  const spec = BILL_CADENCES[bill.cadence] ?? BILL_CADENCES.monthly;
  return spec.months
    ? addMonthsToDate(bill.startDate, index * spec.months)
    : addDays(bill.startDate, index * spec.days);
}

/**
 * The first occurrence falling on or after `iso`.
 *
 * Jumped to arithmetically and then walked the last step or two, because a
 * month-based cadence does not divide evenly into days — and a clamped due date
 * (the 31st landing on the 28th) can put the arithmetic one occurrence out.
 */
function firstIndexOnOrAfter(bill: Bill, iso: ISODate): number {
  const spec = BILL_CADENCES[bill.cadence] ?? BILL_CADENCES.monthly;
  const guess = spec.months
    ? Math.floor(monthsBetween(bill.startDate, iso) / spec.months)
    : Math.floor(daysBetween(bill.startDate, iso) / spec.days);

  let index = guess;
  // Back off until the occurrence before this one is genuinely earlier, then
  // walk forward to the first that qualifies. Both loops are bounded.
  for (let step = 0; step < 8 && occurrenceAt(bill, index - 1) >= iso; step++) index--;
  for (let step = 0; step < 8 && occurrenceAt(bill, index) < iso; step++) index++;
  return index;
}

const monthsBetween = (from: ISODate, to: ISODate): number => {
  const [fy = 0, fm = 1] = from.split('-').map(Number);
  const [ty = 0, tm = 1] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
};

/** Every due date between two dates, inclusive, respecting the bill's end. */
export function occurrencesBetween(bill: Bill, from: ISODate, to: ISODate): ISODate[] {
  if (!bill.startDate || from > to) return [];
  const out: ISODate[] = [];
  let index = Math.max(0, firstIndexOnOrAfter(bill, from));
  for (let step = 0; step < MAX_OCCURRENCES; step++) {
    const date = occurrenceAt(bill, index + step);
    if (date > to) break;
    if (bill.endDate && date > bill.endDate) break;
    if (date >= from) out.push(date);
  }
  return out;
}

/** Every due date in one calendar month. */
export function occurrencesInMonth(bill: Bill, month: MonthKey): ISODate[] {
  return occurrencesBetween(bill, `${month}-01`, `${month}-${String(daysInMonth(month)).padStart(2, '0')}`);
}

export const isSkipped = (bill: Bill, dueDate: ISODate): boolean =>
  (bill.skipped ?? []).includes(dueDate);

/** The transaction settling one occurrence, if there is one. */
export function billPaymentFor(
  state: AppState,
  billId: string,
  dueDate: ISODate,
  index: PaymentIndex = billPayments(state),
): Transaction | null {
  return index.get(paymentKey(billId, dueDate)) ?? null;
}

/**
 * Existing transactions that could settle one occurrence instead of a new
 * payment being recorded for it.
 *
 * Already-linked transactions are excluded — pointing this occurrence at one
 * would silently steal it from whatever it currently settles, rather than
 * leaving that decision to an explicit unlink first. Sorted by how close each
 * one falls to the due date, since that is the strongest signal available
 * that a transaction typed in by hand — or read off a statement before the
 * bill was ever tracked — is this occurrence and not some other month's.
 */
export function linkableTransactions(state: AppState, bill: Bill, dueDate: ISODate): Transaction[] {
  // The bill's usual account, when it has one, is where the payment most
  // likely landed — worth trying before the date is what breaks the tie.
  const onUsualAccount = (tx: Transaction): number =>
    bill.accountId && tx.accountId === bill.accountId ? 0 : 1;

  return state.transactions
    .filter((tx) => !tx.system && !tx.billId && tx.kind === 'expense' && tx.amount < 0)
    .sort(
      (a, b) =>
        onUsualAccount(a) - onUsualAccount(b) ||
        Math.abs(daysBetween(dueDate, a.date)) - Math.abs(daysBetween(dueDate, b.date)),
    );
}

/**
 * What one occurrence is expected to cost.
 *
 * A fixed bill costs what it says. A **variable** one — a metered utility —
 * is forecast from what it has actually been costing, because a figure typed in
 * once when the bill was created is out of date by its second winter. The
 * stated amount is the fallback until there is history to average.
 */
export function forecastAmount(state: AppState, bill: Bill, window = 3): Cents {
  if (!bill.variable) return Math.max(0, bill.amount);
  const recent = state.transactions
    .filter((tx) => tx.billId === bill.id && tx.amount < 0)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, window);
  if (!recent.length) return Math.max(0, bill.amount);
  const total = recent.reduce((sum, tx) => sum + -tx.amount, 0);
  return Math.round(total / recent.length);
}

function toOccurrence(
  state: AppState,
  bill: Bill,
  dueDate: ISODate,
  { asOf, index, forecast }: { asOf: ISODate; index: PaymentIndex; forecast: Cents },
): BillOccurrence {
  const paid = billPaymentFor(state, bill.id, dueDate, index);
  const skipped = isSkipped(bill, dueDate);
  const daysUntilDue = daysBetween(asOf, dueDate);
  return {
    bill,
    dueDate,
    amount: paid ? Math.abs(paid.amount) : forecast,
    paid,
    skipped,
    status: paid
      ? 'paid'
      : skipped
        ? 'skipped'
        : daysUntilDue < 0
          ? 'overdue'
          : daysUntilDue === 0
            ? 'due-today'
            : daysUntilDue <= BILL_DUE_SOON_DAYS
              ? 'due-soon'
              : 'upcoming',
    daysUntilDue,
  };
}

/* ── Snapshots ────────────────────────────────────────────────────────── */

export function billSnapshot(
  state: AppState,
  bill: Bill,
  { asOf = todayISO(), month = currentMonth() }: BillOptions = {},
  index: PaymentIndex = billPayments(state),
): BillSnapshot {
  const forecast = forecastAmount(state, bill);
  const occurrence = (dueDate: ISODate): BillOccurrence =>
    toOccurrence(state, bill, dueDate, { asOf, index, forecast });

  const window = occurrencesBetween(
    bill,
    addDays(asOf, -BILL_OVERDUE_LOOKBACK_DAYS),
    addDays(asOf, HORIZON_DAYS),
  ).map(occurrence);
  const next = window.find((entry) => !entry.paid && !entry.skipped) ?? null;

  const thisMonth = occurrencesInMonth(bill, month).map(occurrence);
  let dueThisMonth = 0;
  let paidThisMonth = 0;
  for (const entry of thisMonth) {
    if (entry.paid) paidThisMonth += entry.amount;
    else if (!entry.skipped) dueThisMonth += entry.amount;
  }

  const lastPaid = state.transactions
    .filter((tx) => tx.billId === bill.id)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null;

  const perYear = (BILL_CADENCES[bill.cadence] ?? BILL_CADENCES.monthly).perYear;

  return {
    bill,
    category: state.categories.find((c) => c.id === bill.categoryId) ?? null,
    account: state.accounts.find((a) => a.id === bill.accountId) ?? null,
    next,
    // No occurrence left in a window stretching from two months back to over a
    // year ahead means the schedule has run out, not that nothing is due.
    status: next ? next.status : window.length ? 'paid' : 'ended',
    daysUntilDue: next?.daysUntilDue ?? Infinity,
    expected: next?.amount ?? forecast,
    lastPaid,
    thisMonth,
    dueThisMonth,
    paidThisMonth,
    monthlyEquivalent: Math.round((forecast * perYear) / 12),
  };
}

/** Every bill, the one wanting attention soonest first. */
export function billSnapshots(
  state: AppState,
  opts: BillOptions & { includeArchived?: boolean } = {},
): BillSnapshot[] {
  const index = billPayments(state);
  return activeBills(state, { includeArchived: opts.includeArchived })
    .map((bill) => billSnapshot(state, bill, opts, index))
    .sort(
      (a, b) =>
        a.daysUntilDue - b.daysUntilDue ||
        a.bill.name.localeCompare(b.bill.name),
    );
}

/** Bills due inside `days` — overdue ones always included. */
export function upcomingBills(
  state: AppState,
  { days = 30, asOf = todayISO(), month = monthOf(asOf) }: BillOptions & { days?: number } = {},
): BillSnapshot[] {
  return billSnapshots(state, { asOf, month }).filter(
    (snapshot) => snapshot.next != null && snapshot.daysUntilDue <= days,
  );
}

/** Every unsettled occurrence in one month, soonest first. */
export function outstandingInMonth(
  state: AppState,
  { asOf = todayISO(), month = currentMonth() }: BillOptions = {},
): BillOccurrence[] {
  return billSnapshots(state, { asOf, month })
    .flatMap((snapshot) => snapshot.thisMonth)
    .filter((entry) => !entry.paid && !entry.skipped)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
}

export function billTotals(state: AppState, opts: BillOptions = {}): BillTotals {
  const bills = billSnapshots(state, opts);
  let dueThisMonth = 0;
  let paidThisMonth = 0;
  let unpaidThisMonth = 0;
  let overdue = 0;
  let monthlyCommitment = 0;

  for (const snapshot of bills) {
    dueThisMonth += snapshot.dueThisMonth + snapshot.paidThisMonth;
    paidThisMonth += snapshot.paidThisMonth;
    unpaidThisMonth += snapshot.dueThisMonth;
    monthlyCommitment += snapshot.monthlyEquivalent;
    if (snapshot.status === 'overdue') overdue++;
  }

  return {
    bills,
    outstanding: outstandingInMonth(state, opts),
    dueThisMonth,
    paidThisMonth,
    unpaidThisMonth,
    overdue,
    monthlyCommitment,
  };
}

/* ── Funding ──────────────────────────────────────────────────────────── */

/**
 * Whether the envelopes hold what this month's remaining bills will cost.
 *
 * This is the bill half of the coverage question the card views ask: a bill
 * with a due date and no money behind it is the thing worth knowing about
 * *before* the date arrives, and the envelope it draws on is where that money
 * has to be. Bills sharing a category are added up first, because they share
 * one envelope and will empty it in turn.
 */
export function billFunding(
  state: AppState,
  { asOf = todayISO(), month = currentMonth() }: BillOptions = {},
): BillFunding {
  const summary = monthSummary(state, month);
  const byCategory = new Map<string, { due: Cents; soonest: ISODate | null }>();

  for (const entry of outstandingInMonth(state, { asOf, month })) {
    const key = entry.bill.categoryId ?? '';
    const bucket = byCategory.get(key) ?? { due: 0, soonest: null };
    bucket.due += entry.amount;
    if (!bucket.soonest || entry.dueDate < bucket.soonest) bucket.soonest = entry.dueDate;
    byCategory.set(key, bucket);
  }

  const rows: BillFundingRow[] = [];
  let due = 0;
  let uncovered = 0;
  let unfundedCount = 0;

  for (const [key, bucket] of byCategory) {
    const category = key ? state.categories.find((c) => c.id === key) ?? null : null;
    // An uncategorised bill has no envelope to hold anything, so none of it is
    // covered — which is exactly what the view should say about it.
    const available = category ? categoryRow(summary, category.id).available : 0;
    const short = Math.max(0, bucket.due - Math.max(0, available));
    rows.push({
      categoryId: category?.id ?? null,
      category,
      due: bucket.due,
      available: category ? available : 0,
      uncovered: short,
      soonest: bucket.soonest,
    });
    due += bucket.due;
    uncovered += short;
    if (short > 0) unfundedCount++;
  }

  rows.sort((a, b) => (a.soonest ?? '9999').localeCompare(b.soonest ?? '9999'));
  return { rows, due, uncovered, unfundedCount };
}

/* ── Reading a bill off the ledger ────────────────────────────────────── */

/**
 * A bill drafted from a transaction that looks like one of a series.
 *
 * Offered rather than created: "you have paid Fibrenet on the 5th for three
 * months" is a strong hint and a weak fact, so the guess is handed to the form
 * with the figures filled in and a person decides.
 */
export function suggestedBills(state: AppState, { limit = 4 }: { limit?: number } = {}): Array<Partial<Bill>> {
  const tracked = new Set(
    (state.bills ?? []).map((bill) => (bill.payee || bill.name).trim().toLowerCase()),
  );
  const counts = new Map<string, number>();
  for (const tx of state.transactions) {
    if (tx.kind !== 'expense' || tx.amount >= 0 || !tx.payee.trim() || tx.billId) continue;
    counts.set(tx.payee, (counts.get(tx.payee) ?? 0) + 1);
  }

  const drafts: Array<Partial<Bill>> = [];
  for (const [payee, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    if (count < 3 || tracked.has(payee.trim().toLowerCase())) continue;
    const draft = billFromHistory(state, payee);
    if (draft) drafts.push(draft);
    if (drafts.length >= limit) break;
  }
  return drafts;
}

export function billFromHistory(state: AppState, payee: string): Partial<Bill> | null {
  const matches = state.transactions
    .filter((tx) => tx.kind === 'expense' && tx.amount < 0 && tx.payee === payee && !tx.billId)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 6);
  if (matches.length < 3) return null;

  const gaps: number[] = [];
  for (let i = 1; i < matches.length; i++) {
    const later = matches[i - 1]?.date;
    const earlier = matches[i]?.date;
    if (later && earlier) gaps.push(daysBetween(earlier, later));
  }
  if (gaps.length < 2) return null;
  const typical = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;

  // Two things separate a bill from a shop you happen to like.
  //
  // It arrives **on a calendar rhythm**, monthly at the shortest — anything
  // more frequent than that cannot be told apart from ordinary spending by its
  // dates alone, and guessing produces exactly the wrong suggestions: the
  // supermarket, the coffee place, the petrol station.
  //
  // And the rhythm is **regular**. Three visits to the same restaurant average
  // out to some interval too; what they do not do is repeat it within a few
  // days each time.
  if (typical < 20) return null;
  const tolerance = Math.max(4, Math.round(typical * 0.2));
  if (gaps.some((gap) => Math.abs(gap - typical) > tolerance)) return null;

  const cadence: Bill['cadence'] =
    typical <= 45 ? 'monthly' : typical <= 135 ? 'quarterly'
      : typical <= 250 ? 'semiannual' : 'annual';

  const latest = matches[0];
  if (!latest) return null;
  const amounts = matches.map((tx) => -tx.amount);
  const spread = Math.max(...amounts) - Math.min(...amounts);
  const average = Math.round(amounts.reduce((sum, value) => sum + value, 0) / amounts.length);

  // The longer the cycle, the thinner the evidence: three payments a quarter
  // apart is a year of history and two data points about the rhythm. Amounts
  // that also hold steady are what make it a commitment rather than a
  // coincidence, so they are required before guessing beyond monthly.
  if (cadence !== 'monthly' && spread > average * 0.3) return null;

  return {
    name: payee,
    payee,
    amount: average,
    // Anything that has moved by more than a twentieth is not a fixed bill.
    variable: spread > average / 20,
    cadence,
    startDate: latest.date,
    categoryId: latest.categoryId,
    accountId: latest.accountId,
  };
}
