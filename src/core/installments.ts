/**
 * Instalment plans: what is still to be billed, and when it stops.
 *
 * Everything here is **derived** from the plan's own terms rather than stored
 * as progress. A plan knows the month it started, what it bills and for how
 * long; how far through it is falls out of the calendar. Storing a "months
 * paid" counter instead would need advancing by hand every month, and would be
 * wrong the moment somebody forgot.
 *
 * None of this touches the ledger. Each month's instalment reaches the budget
 * as an ordinary charge — typed in, or imported off the statement — and the
 * plan exists to say what is coming *after* that. See `core/model.ts` for why
 * generating the charges here would bill everything twice.
 */

import { addMonths, compareMonths, currentMonth, monthOf } from './dates.ts';
import type { AppState, Cents, Installment, MonthKey } from './model.ts';

export interface InstallmentSnapshot {
  plan: Installment;
  /** Instalments billed as of the month asked about, capped at the term. */
  billed: number;
  remainingMonths: number;
  /** Still to be billed. */
  remainingAmount: Cents;
  /** Billed so far. */
  billedAmount: Cents;
  totalAmount: Cents;
  /** The month the last instalment falls in. */
  lastMonth: MonthKey;
  /** True once every instalment has been billed. */
  finished: boolean;
  /** True when this month is one of the billed months. */
  activeThisMonth: boolean;
  /** 0–1, for a progress meter. */
  progress: number;
  /**
   * What the plan adds over the purchase price, when the price is known. A
   * genuinely 0% plan returns 0; anything else names its cost. Prefers the
   * plan's own monthly split when it has one — that is the issuer's own
   * figure, exact rather than inferred from the price.
   */
  interestCost: Cents | null;
  /** The principal portion of each monthly billing — all of it, absent a split. */
  monthlyPrincipal: Cents;
  /** The interest portion of each monthly billing — none of it, absent a split. */
  monthlyInterest: Cents;
  /** Principal paid down by the instalments billed so far. */
  billedPrincipal: Cents;
  /** Interest paid so far. */
  billedInterest: Cents;
  /** Principal still to be paid down by what is left of the plan. */
  remainingPrincipal: Cents;
  /** Interest still to come. */
  remainingInterest: Cents;
}

export interface InstallmentSummary {
  plans: InstallmentSnapshot[];
  /** Billed across all active plans in the month asked about. */
  monthly: Cents;
  /** Everything still to be billed, across every unfinished plan. */
  remaining: Cents;
  activeCount: number;
}

/** Months since the epoch, so two month keys can be subtracted. */
const monthIndex = (month: MonthKey): number => {
  const [year = 0, part = 1] = month.split('-').map(Number);
  return year * 12 + (part - 1);
};

export function installmentSnapshot(
  plan: Installment,
  month: MonthKey = currentMonth(),
): InstallmentSnapshot {
  const months = Math.max(0, Math.round(plan.months) || 0);
  const monthlyAmount = Math.max(0, Math.round(plan.monthlyAmount) || 0);
  const totalAmount = months * monthlyAmount;
  const lastMonth = months > 0 ? addMonths(plan.startMonth, months - 1) : plan.startMonth;

  const elapsed = plan.startMonth ? monthIndex(month) - monthIndex(plan.startMonth) : -1;
  const billed = Math.min(months, Math.max(0, elapsed + 1));
  const remainingMonths = Math.max(0, months - billed);

  // Absent a split, every peso of the billing is assumed to pay down the
  // price — the same assumption a genuine 0% plan makes, and the only one
  // that can be made without the issuer's own breakdown.
  const hasSplit = plan.monthlyPrincipal != null || plan.monthlyInterest != null;
  const monthlyInterest = Math.max(0, Math.round(plan.monthlyInterest ?? 0));
  const monthlyPrincipal = Math.max(0, Math.round(plan.monthlyPrincipal ?? monthlyAmount - monthlyInterest));

  return {
    plan,
    billed,
    remainingMonths,
    remainingAmount: remainingMonths * monthlyAmount,
    billedAmount: billed * monthlyAmount,
    totalAmount,
    lastMonth,
    finished: months > 0 && billed >= months,
    activeThisMonth: elapsed >= 0 && elapsed < months,
    progress: months > 0 ? billed / months : 0,
    interestCost: hasSplit
      ? monthlyInterest * months
      : plan.principal == null
        ? null
        : Math.max(0, totalAmount - plan.principal),
    monthlyPrincipal,
    monthlyInterest,
    billedPrincipal: billed * monthlyPrincipal,
    billedInterest: billed * monthlyInterest,
    remainingPrincipal: remainingMonths * monthlyPrincipal,
    remainingInterest: remainingMonths * monthlyInterest,
  };
}

/** Every plan on a card, soonest to finish first. */
export function cardInstallments(
  state: AppState,
  cardId: string,
  month: MonthKey = currentMonth(),
): InstallmentSnapshot[] {
  return (state.installments ?? [])
    .filter((plan) => plan.accountId === cardId)
    .map((plan) => installmentSnapshot(plan, month))
    .sort((a, b) => compareMonths(a.lastMonth, b.lastMonth) || a.plan.description.localeCompare(b.plan.description));
}

/**
 * Totals for one card, or for every card when `cardId` is null.
 *
 * `monthly` answers the question a budget actually asks — how much of this
 * month's bill is already spoken for before any new spending.
 */
export function installmentSummary(
  state: AppState,
  { cardId = null, month = currentMonth() }: { cardId?: string | null; month?: MonthKey } = {},
): InstallmentSummary {
  const plans = (state.installments ?? [])
    .filter((plan) => cardId == null || plan.accountId === cardId)
    .map((plan) => installmentSnapshot(plan, month))
    .sort((a, b) => compareMonths(a.lastMonth, b.lastMonth));

  let monthly = 0;
  let remaining = 0;
  let activeCount = 0;
  for (const snapshot of plans) {
    remaining += snapshot.remainingAmount;
    if (snapshot.activeThisMonth) {
      monthly += snapshot.plan.monthlyAmount;
      activeCount++;
    }
  }
  return { plans, monthly, remaining, activeCount };
}

/* ── Reading a plan off a statement ───────────────────────────────────── */

export interface InstallmentMarker {
  /** Which instalment this row is: the 3 of "3/12". */
  index: number;
  /** How many there are in total: the 12 of "3/12". */
  total: number;
}

/**
 * Words that mean a row is one instalment of a plan rather than a purchase.
 */
// Both spellings: issuers print the double-l "installment" as often as not.
const INSTALLMENT_WORDS = /instal{1,2}ment|\binstl?\b|amort|\bplan\b|\bmos\b|\bmonths?\b/i;

/**
 * Find the `3/12` an instalment row carries.
 *
 * The two forms are not equally trustworthy. `3 of 12` can only be an
 * instalment, so it is taken at face value. A bare `3/12` is also how half the
 * world writes a **date** — `PAYMENT 06/18` is the 18th of June, and reads
 * perfectly well as "the sixth of eighteen" — so that form is only believed
 * when the row says outright that it is an instalment. Numbers alone cannot
 * separate the two, and inventing a nine-month commitment out of a date is a
 * worse failure than missing one.
 */
export function parseInstallmentMarker(description: string): InstallmentMarker | null {
  const spelled = /\b(\d{1,2})\s+of\s+(\d{1,2})\b/i.exec(description);
  const slashed = INSTALLMENT_WORDS.test(description)
    ? /\b(\d{1,2})\s*\/\s*(\d{1,2})\b/.exec(description)
    : null;

  for (const match of [spelled, slashed]) {
    if (!match) continue;
    const index = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isFinite(index) || !Number.isFinite(total)) continue;
    // A plan runs at least twice, never more than five years, and cannot be on
    // its fourteenth of twelve.
    if (index < 1 || total < 2 || index > total || total > 60) continue;
    return { index, total };
  }
  return null;
}

/**
 * Build a plan from one instalment row on a statement.
 *
 * The start month is the row's own month counted back by the instalments
 * already billed: the third of twelve on a June statement began in April. That
 * makes a plan recoverable from any single statement, rather than only from the
 * one that started it.
 */
export function planFromStatementRow(
  { description, amount, date }: { description: string; amount: Cents; date: string },
  accountId: string,
): Omit<Installment, 'id'> | null {
  const marker = parseInstallmentMarker(description);
  if (!marker || amount <= 0) return null;
  return {
    accountId,
    description: description.replace(/\s*\b\d{1,2}\s*(?:\/|\s+of\s+)\s*\d{1,2}\b\s*/i, ' ').replace(/\s+/g, ' ').trim(),
    monthlyAmount: amount,
    months: marker.total,
    startMonth: addMonths(monthOf(date), -(marker.index - 1)),
    principal: null,
    note: '',
  };
}

/** Is this plan already tracked on this card? */
export function findMatchingPlan(
  state: AppState,
  candidate: Omit<Installment, 'id'>,
): Installment | null {
  return (
    (state.installments ?? []).find(
      (plan) =>
        plan.accountId === candidate.accountId &&
        plan.months === candidate.months &&
        plan.startMonth === candidate.startMonth &&
        plan.monthlyAmount === candidate.monthlyAmount,
    ) ?? null
  );
}
