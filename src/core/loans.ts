/**
 * Loans: what is owed, what is left to pay, and when it ends.
 *
 * A loan is the mirror image of a credit card. A card's balance grows when you
 * spend and its payment envelope fills itself as you do; a loan's balance only
 * falls, and its envelope has to be filled *deliberately*, month by month,
 * before the due date. That is the whole difference, and it is why the two
 * share a payment envelope but almost nothing else.
 *
 * Progress is derived from the ledger and the calendar rather than stored, for
 * the same reason instalment plans are: a counter would need advancing by hand.
 */

import { accountBalance, categoryRow, monthSummary } from './budget.ts';
import { addMonths, compareMonths, currentMonth, daysBetween, nextDayOfMonth, todayISO } from './dates.ts';
import { isLoan, paymentCategoryFor } from './model.ts';
import type { AppState, Category, Cents, ISODate, LoanAccount, MonthKey } from './model.ts';

export interface LoanSnapshot {
  loan: LoanAccount;
  paymentCategory: Category | null;
  /** Still owed, positive. */
  balance: Cents;
  /** Set aside in this loan's payment envelope. */
  reserved: Cents;
  /** True when the envelope holds this month's payment. */
  readyForNextPayment: boolean;
  /** Repaid so far, as far as the original principal says. */
  repaid: Cents;
  /** 0–1 against the original principal. */
  progress: number;
  /** Payments made, by the calendar. */
  paymentsMade: number;
  paymentsRemaining: number;
  /** The month the last payment falls in, when a term is known. */
  finalMonth: MonthKey | null;
  nextDueDate: ISODate;
  daysUntilDue: number;
  /** Everything still to be paid at the agreed monthly amount. */
  remainingToPay: Cents;
  /**
   * What the loan costs over its life: total payments minus the principal.
   * Null unless both a term and a principal are known.
   */
  totalInterest: Cents | null;
  /** One more month of interest on the balance, at the stated rate. */
  monthlyInterestCost: Cents;
}

const monthIndex = (month: MonthKey): number => {
  const [year = 0, part = 1] = month.split('-').map(Number);
  return year * 12 + (part - 1);
};

export const loanAccounts = (
  state: AppState,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): LoanAccount[] =>
  state.accounts.filter((a): a is LoanAccount => isLoan(a) && (includeArchived || !a.archived));

/** Amount owed on a loan, returned positive. */
export function loanBalance(state: AppState, loanId: string, throughISO: ISODate | null = null): Cents {
  return -accountBalance(state, loanId, throughISO) || 0;
}

export function loanSnapshot(
  state: AppState,
  loan: LoanAccount,
  { month = currentMonth(), asOf = todayISO() }: { month?: MonthKey; asOf?: ISODate } = {},
): LoanSnapshot {
  const balance = loanBalance(state, loan.id);
  const paymentCategory = paymentCategoryFor(state, loan.id);
  const row = paymentCategory ? categoryRow(monthSummary(state, month), paymentCategory.id) : null;
  const reserved = Math.max(0, row?.available ?? 0);

  const term = Math.max(0, Math.round(loan.termMonths) || 0);
  const monthly = Math.max(0, Math.round(loan.monthlyPayment) || 0);
  const elapsed = loan.startMonth ? monthIndex(month) - monthIndex(loan.startMonth) : -1;
  const paymentsMade = term ? Math.min(term, Math.max(0, elapsed + 1)) : Math.max(0, elapsed + 1);
  const paymentsRemaining = term ? Math.max(0, term - paymentsMade) : 0;

  const principal = Math.max(0, loan.principal || 0);
  const repaid = principal ? Math.max(0, principal - balance) : 0;

  const nextDueDate = nextDayOfMonth(loan.dueDay || 5, asOf);

  return {
    loan,
    paymentCategory,
    balance,
    reserved,
    readyForNextPayment: monthly > 0 && reserved >= monthly,
    repaid,
    progress: principal ? Math.min(1, repaid / principal) : 0,
    paymentsMade,
    paymentsRemaining,
    finalMonth: term && loan.startMonth ? addMonths(loan.startMonth, term - 1) : null,
    nextDueDate,
    daysUntilDue: daysBetween(asOf, nextDueDate),
    remainingToPay: paymentsRemaining * monthly,
    totalInterest: term && principal ? Math.max(0, term * monthly - principal) : null,
    monthlyInterestCost: balance > 0 && loan.apr ? Math.round(balance * (loan.apr / 12)) : 0,
  };
}

export function loanSnapshots(
  state: AppState,
  opts: { month?: MonthKey; asOf?: ISODate } = {},
): LoanSnapshot[] {
  return loanAccounts(state)
    .map((loan) => loanSnapshot(state, loan, opts))
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);
}

export interface LoanTotals {
  loans: LoanSnapshot[];
  balance: Cents;
  /** Committed every month across every loan still running. */
  monthly: Cents;
  reserved: Cents;
  /** Loans whose envelope does not yet hold this month's payment. */
  unfunded: number;
}

export function loanTotals(state: AppState, opts: { month?: MonthKey; asOf?: ISODate } = {}): LoanTotals {
  const loans = loanSnapshots(state, opts);
  let balance = 0;
  let monthly = 0;
  let reserved = 0;
  let unfunded = 0;
  for (const snapshot of loans) {
    balance += snapshot.balance;
    reserved += snapshot.reserved;
    // A loan that has finished its term still bills nothing, whatever the
    // balance says — an overpaid or written-off loan should not be counted as
    // a monthly commitment that no longer exists.
    if (snapshot.balance > 0 && (snapshot.paymentsRemaining > 0 || !snapshot.loan.termMonths)) {
      monthly += snapshot.loan.monthlyPayment;
      if (!snapshot.readyForNextPayment) unfunded++;
    }
  }
  return { loans, balance, monthly, reserved, unfunded };
}

/** Loans with a payment due inside `days`, soonest first. */
export function upcomingLoanPayments(
  state: AppState,
  { days = 21, asOf = todayISO() }: { days?: number; asOf?: ISODate } = {},
): LoanSnapshot[] {
  return loanSnapshots(state, { asOf }).filter(
    (snapshot) => snapshot.balance > 0 && snapshot.daysUntilDue <= days,
  );
}

/** True when this loan's term has run out but a balance remains. */
export function isOverdueTerm(snapshot: LoanSnapshot, month: MonthKey = currentMonth()): boolean {
  if (!snapshot.finalMonth || snapshot.balance <= 0) return false;
  return compareMonths(month, snapshot.finalMonth) > 0;
}
