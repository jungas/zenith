/**
 * The budget engine — pure functions over state, no DOM, no storage.
 *
 * ── How credit cards connect to the budget ────────────────────────────────
 *
 * Every credit account owns a "payment" envelope. Three rules keep the two
 * halves of the app in sync:
 *
 *   1. Spending on a card is budgeted like any other spending: the expense
 *      draws down the *category* envelope (Groceries, Dining, …).
 *   2. That same spend moves cash into the card's *payment* envelope. The
 *      money never left your chequing account, so the budget parks it against
 *      the debt you just created.
 *   3. Paying the card is a transfer out of chequing categorised to the card's
 *      payment envelope, which spends the reserve back down to zero.
 *
 * The result is an invariant the app checks at runtime (see `reconcile`):
 *
 *     readyToAssign + Σ available === Σ cash in asset accounts
 *
 * Card debt does not appear in it, and that is the point: the reserve an
 * envelope holds for a card exactly cancels the debt that created it, so every
 * envelope balance is backed by real cash sitting in a real account.
 *
 * Debt that predates the budget is the one thing with no reserve behind it. It
 * moves the card's balance without ever being income, so it drops out of the
 * identity above and surfaces instead as *uncovered* debt on the card — the
 * number that actually accrues interest.
 */

import { addMonths, compareMonths, currentMonth, monthOf, monthRange, todayISO } from './dates.ts';
import { isAsset, isCredit, isDebt } from './model.ts';
import type { AppState, Cents, ISODate, MonthKey, Transaction, TxKind } from './model.ts';

/** One category's standing in one month. */
export interface CategoryRowSummary {
  categoryId: string;
  /** Positive balance carried in from last month. */
  rollover: Cents;
  /** What you assigned this month. */
  budgeted: Cents;
  /** Signed total of transactions in this category. */
  activity: Cents;
  /** Card payment envelopes only: cash set aside by card spending. */
  reserved: Cents;
  available: Cents;
}

export interface MonthSummary {
  month: MonthKey;
  rows: Map<string, CategoryRowSummary>;
  /** Real income. Opening balances are excluded — see `startingFunds`. */
  income: Cents;
  /** Opening balances landing in this month: budgetable, but not income. */
  startingFunds: Cents;
  spending: Cents;
  budgeted: Cents;
  overspent: Cents;
  /**
   * Money that left an asset account without being budgeted anywhere. It comes
   * straight out of Ready to assign — see `buildLedger`.
   */
  unbudgeted: Cents;
  /** Cash that has arrived but has not been given a job yet. */
  readyToAssign: Cents;
}

export interface Reconciliation {
  readyToAssign: Cents;
  available: Cents;
  /** Part of `available`, reported separately because it is the card link. */
  cardReserves: Cents;
  cash: Cents;
  debt: Cents;
  expected: Cents;
  difference: Cents;
  balanced: boolean;
}

export interface MonthTotals {
  month: MonthKey;
  income: Cents;
  spending: Cents;
  net: Cents;
}

export interface TransactionFilters {
  accountId?: string;
  categoryId?: string;
  month?: MonthKey;
  search?: string;
  kind?: TxKind;
  limit?: number;
}

/**
 * User transactions plus a synthesised opening-balance entry per account, so
 * balances and income both fall out of one list.
 *
 * An asset account's opening balance is money you can budget. A **debt**
 * account's opening balance — a card's or a loan's — is money already owed: it
 * moves that account's balance but is deliberately *not* income and *not*
 * category activity. You never budgeted for it, and pretending otherwise would
 * invent money. It shows up instead as debt the budget has yet to cover.
 */
export function ledgerTransactions(state: AppState): Transaction[] {
  const synthetic: Transaction[] = [];
  for (const account of state.accounts) {
    if (!account.openingBalance) continue;
    synthetic.push({
      id: `opening_${account.id}`,
      date: account.openedOn || state.settings?.createdAt?.slice(0, 10) || todayISO(),
      accountId: account.id,
      categoryId: null,
      payee: 'Starting balance',
      memo: '',
      amount: account.openingBalance,
      kind: isDebt(account) ? 'adjustment' : 'income',
      cleared: true,
      transferId: null,
      system: true,
    });
  }
  return [...synthetic, ...state.transactions];
}

export function accountBalance(
  state: AppState,
  accountId: string,
  throughISO: ISODate | null = null,
): Cents {
  let total = 0;
  for (const tx of ledgerTransactions(state)) {
    if (tx.accountId !== accountId) continue;
    if (throughISO && tx.date > throughISO) continue;
    total += tx.amount;
  }
  return total;
}

export function accountBalances(
  state: AppState,
  throughISO: ISODate | null = null,
): Map<string, Cents> {
  const balances = new Map<string, Cents>(state.accounts.map((a) => [a.id, 0]));
  for (const tx of ledgerTransactions(state)) {
    if (throughISO && tx.date > throughISO) continue;
    if (tx.accountId == null) continue;
    const current = balances.get(tx.accountId);
    if (current === undefined) continue;
    balances.set(tx.accountId, current + tx.amount);
  }
  return balances;
}

/** Cash in asset accounts. Debt is excluded — see `totalDebt`. */
export function cashOnHand(state: AppState, throughISO: ISODate | null = null): Cents {
  const balances = accountBalances(state, throughISO);
  let total = 0;
  for (const account of state.accounts) {
    if (isAsset(account)) total += balances.get(account.id) ?? 0;
  }
  return total;
}

/** Total owed on credit cards, returned positive. */
export function totalDebt(state: AppState, throughISO: ISODate | null = null): Cents {
  return owedAcross(state, throughISO, isCredit);
}

/** Total owed across every debt account — cards and loans alike. */
export function totalOwed(state: AppState, throughISO: ISODate | null = null): Cents {
  return owedAcross(state, throughISO, isDebt);
}

function owedAcross(
  state: AppState,
  throughISO: ISODate | null,
  matches: (account: AppState['accounts'][number]) => boolean,
): Cents {
  const balances = accountBalances(state, throughISO);
  let total = 0;
  for (const account of state.accounts) {
    if (matches(account)) total += Math.min(0, balances.get(account.id) ?? 0);
  }
  return -total || 0;
}

export function netWorth(state: AppState, throughISO: ISODate | null = null): Cents {
  let total = 0;
  for (const balance of accountBalances(state, throughISO).values()) total += balance;
  return total;
}

/** The span of months the ledger covers, always including the current month. */
export function ledgerMonths(state: AppState, throughMonth: MonthKey = currentMonth()): MonthKey[] {
  const keys: MonthKey[] = [currentMonth(), throughMonth];
  for (const tx of ledgerTransactions(state)) keys.push(monthOf(tx.date));
  for (const key of Object.keys(state.budgets ?? {})) keys.push(key);

  let first = throughMonth;
  let last = throughMonth;
  for (const key of keys) {
    if (compareMonths(key, first) < 0) first = key;
    if (compareMonths(key, last) > 0) last = key;
  }
  return monthRange(first, last);
}

/**
 * Walk every month from the first to `throughMonth`, carrying envelope
 * balances forward. Returns a Map of monthKey -> month summary.
 *
 * Rollover rule: a positive envelope balance rolls into next month. A negative
 * one does not — overspending is absorbed by next month's Ready to assign,
 * which is what actually happened to the money.
 */
export function buildLedger(
  state: AppState,
  throughMonth: MonthKey = currentMonth(),
): Map<MonthKey, MonthSummary> {
  const months = ledgerMonths(state, throughMonth);

  // Index the lookups this loop would otherwise repeat for every transaction.
  const accountsById = new Map(state.accounts.map((a) => [a.id, a]));
  const categoriesById = new Map(state.categories.map((c) => [c.id, c]));
  const paymentCategoryByAccount = new Map<string, string>();
  for (const category of state.categories) {
    if (category.kind === 'ccPayment' && category.accountId) {
      paymentCategoryByAccount.set(category.accountId, category.id);
    }
  }

  // Bucket every transaction once, by month, instead of re-scanning per month.
  const byMonth = new Map<MonthKey, Transaction[]>(months.map((m) => [m, []]));
  for (const tx of ledgerTransactions(state)) {
    byMonth.get(monthOf(tx.date))?.push(tx);
  }

  const ledger = new Map<MonthKey, MonthSummary>();
  let previous: MonthSummary | null = null;
  let fundsToDate = 0;
  let budgetedToDate = 0;
  let overspentCarried = 0;
  let unbudgetedToDate = 0;

  for (const month of months) {
    const transactions = byMonth.get(month) ?? [];
    const budgets = state.budgets?.[month] ?? {};

    const rows = new Map<string, CategoryRowSummary>();
    for (const category of state.categories) {
      rows.set(category.id, {
        categoryId: category.id,
        rollover: previous ? Math.max(0, previous.rows.get(category.id)?.available ?? 0) : 0,
        budgeted: budgets[category.id] ?? 0,
        activity: 0,
        reserved: 0,
        available: 0,
      });
    }

    let income = 0;
    let startingFunds = 0;
    let spending = 0;
    let unbudgeted = 0;

    for (const tx of transactions) {
      // An opening balance is money to budget, but it is not *income* — folding
      // it in would put a spike in every trend chart in the app.
      if (tx.kind === 'income') {
        if (tx.system) startingFunds += tx.amount;
        else income += tx.amount;
      }

      const row = tx.categoryId ? rows.get(tx.categoryId) : undefined;
      if (row) {
        row.activity += tx.amount;
        if (tx.kind === 'expense' && tx.amount < 0) spending += -tx.amount;
      } else if (tx.kind === 'expense' && tx.amount < 0 && isAsset(accountsById.get(tx.accountId ?? ''))) {
        // Spending with no envelope behind it. The cash has gone, so something
        // has to give: it comes out of Ready to assign, which is the pool of
        // money that has not been given a job. Leaving it out entirely — which
        // is what happened before — made cash fall while the budget went on
        // claiming the money was still there, and the integrity check in
        // Settings would report the gap without being able to explain it.
        //
        // Only from an asset account: the same charge on a credit card moves no
        // cash, so subtracting it would break the identity in the other
        // direction.
        unbudgeted += -tx.amount;
        spending += -tx.amount;
      }

      // Rule 2: spending on a card reserves the same cash for its payment.
      if (!tx.accountId || !tx.categoryId) continue;
      const account = accountsById.get(tx.accountId);
      if (!isCredit(account)) continue;
      if (categoriesById.get(tx.categoryId)?.kind !== 'spending') continue;
      const paymentCategoryId = paymentCategoryByAccount.get(account.id);
      const target = paymentCategoryId ? rows.get(paymentCategoryId) : undefined;
      if (target) target.reserved += -tx.amount;
    }

    let budgeted = 0;
    let overspent = 0;
    for (const row of rows.values()) {
      row.available = row.rollover + row.budgeted + row.activity + row.reserved;
      budgeted += row.budgeted;
      if (row.available < 0) overspent += -row.available;
    }

    fundsToDate += income + startingFunds;
    budgetedToDate += budgeted;
    unbudgetedToDate += unbudgeted;

    const summary: MonthSummary = {
      month,
      rows,
      income,
      startingFunds,
      spending,
      budgeted,
      overspent,
      unbudgeted,
      // Unbudgeted spending bites in the month it happens, unlike overspending
      // an envelope, which is absorbed by the month after.
      readyToAssign: fundsToDate - budgetedToDate - overspentCarried - unbudgetedToDate,
    };
    ledger.set(month, summary);

    overspentCarried += overspent;
    previous = summary;
  }

  return ledger;
}

/** Month summary with a stable empty shape when the month is out of range. */
export function monthSummary(state: AppState, month: MonthKey = currentMonth()): MonthSummary {
  return (
    buildLedger(state, month).get(month) ?? {
      month,
      rows: new Map(),
      income: 0,
      startingFunds: 0,
      spending: 0,
      budgeted: 0,
      overspent: 0,
      unbudgeted: 0,
      readyToAssign: 0,
    }
  );
}

export function categoryRow(summary: MonthSummary, categoryId: string): CategoryRowSummary {
  return (
    summary.rows.get(categoryId) ?? {
      categoryId, rollover: 0, budgeted: 0, activity: 0, reserved: 0, available: 0,
    }
  );
}

export function readyToAssign(state: AppState, month: MonthKey = currentMonth()): Cents {
  return monthSummary(state, month).readyToAssign;
}

/**
 * Runtime check of the identity documented at the top of this file. Surfaced
 * in Settings so a data-shaped bug is visible rather than silent.
 */
export function reconcile(state: AppState, month: MonthKey = currentMonth()): Reconciliation {
  const summary = monthSummary(state, month);
  const endOfMonth = lastDayOf(month);

  let available = 0;
  let cardReserves = 0;
  for (const category of state.categories) {
    const row = categoryRow(summary, category.id);
    available += row.available;
    if (category.kind === 'ccPayment') cardReserves += row.available;
  }

  const cash = cashOnHand(state, endOfMonth);
  const expected = summary.readyToAssign + available;

  return {
    readyToAssign: summary.readyToAssign,
    available,
    cardReserves,
    cash,
    debt: totalDebt(state, endOfMonth),
    expected,
    difference: expected - cash,
    balanced: Math.abs(expected - cash) < 1,
  };
}

function lastDayOf(month: MonthKey): ISODate {
  const [y = 0, m = 1] = month.split('-').map(Number);
  const day = new Date(y, m, 0).getDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

/** Total outflow per category over a month range, positive cents. */
export function spendingByCategory(
  state: AppState,
  fromMonth: MonthKey,
  toMonth: MonthKey,
): Map<string, Cents> {
  const totals = new Map<string, Cents>();
  for (const tx of ledgerTransactions(state)) {
    if (tx.kind !== 'expense' || !tx.categoryId) continue;
    const month = monthOf(tx.date);
    if (compareMonths(month, fromMonth) < 0 || compareMonths(month, toMonth) > 0) continue;
    totals.set(tx.categoryId, (totals.get(tx.categoryId) ?? 0) + -tx.amount);
  }
  return totals;
}

/** Income / spending / net per month, oldest first. */
export function monthlyTotals(state: AppState, months: MonthKey[]): MonthTotals[] {
  const ledger = buildLedger(state, months[months.length - 1] ?? currentMonth());
  return months.map((month) => {
    const summary = ledger.get(month);
    const income = summary?.income ?? 0;
    const spending = summary?.spending ?? 0;
    return { month, income, spending, net: income - spending };
  });
}

/** Transactions newest first, with optional filters. */
export function queryTransactions(
  state: AppState,
  filters: TransactionFilters = {},
): Transaction[] {
  const { accountId, categoryId, month, search, kind, limit } = filters;
  const needle = search?.trim().toLowerCase();
  const rows = ledgerTransactions(state).filter((tx) => {
    if (accountId && tx.accountId !== accountId) return false;
    if (categoryId && tx.categoryId !== categoryId) return false;
    if (month && monthOf(tx.date) !== month) return false;
    if (kind && tx.kind !== kind) return false;
    if (needle && !`${tx.payee} ${tx.memo}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1));
  return limit ? rows.slice(0, limit) : rows;
}

/**
 * Suggested budget for a category: the average of the last `window` complete
 * months of spending, rounded up to the nearest dollar.
 */
export function suggestBudget(
  state: AppState,
  categoryId: string,
  month: MonthKey = currentMonth(),
  window = 3,
): Cents {
  let total = 0;
  for (let i = 1; i <= window; i++) {
    const key = addMonths(month, -i);
    total += spendingByCategory(state, key, key).get(categoryId) ?? 0;
  }
  if (!total) return 0;
  return Math.ceil(total / window / 100) * 100;
}
