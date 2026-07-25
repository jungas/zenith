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

import {
  addMonths, compareMonths, currentMonth, monthOf, monthRange, todayISO,
} from './dates.js';
import { isAsset, isCredit } from './model.js';

/**
 * User transactions plus a synthesised opening-balance entry per account, so
 * balances and income both fall out of one list.
 *
 * An asset account's opening balance is income (it is money you can budget).
 * A credit account's opening balance is pre-existing debt: it moves the card's
 * balance but is deliberately *not* income and *not* category activity — you
 * never budgeted for it, and pretending otherwise would invent money. It shows
 * up instead as uncovered debt on the card.
 */
export function ledgerTransactions(state) {
  const synthetic = [];
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
      kind: isCredit(account) ? 'adjustment' : 'income',
      cleared: true,
      transferId: null,
      system: true,
    });
  }
  return [...synthetic, ...state.transactions];
}

export function accountBalance(state, accountId, throughISO = null) {
  let total = 0;
  for (const tx of ledgerTransactions(state)) {
    if (tx.accountId !== accountId) continue;
    if (throughISO && tx.date > throughISO) continue;
    total += tx.amount;
  }
  return total;
}

export function accountBalances(state, throughISO = null) {
  const balances = new Map(state.accounts.map((a) => [a.id, 0]));
  for (const tx of ledgerTransactions(state)) {
    if (throughISO && tx.date > throughISO) continue;
    if (!balances.has(tx.accountId)) continue;
    balances.set(tx.accountId, balances.get(tx.accountId) + tx.amount);
  }
  return balances;
}

/** Cash in asset accounts. Debt is excluded — see `totalDebt`. */
export function cashOnHand(state, throughISO = null) {
  const balances = accountBalances(state, throughISO);
  let total = 0;
  for (const account of state.accounts) {
    if (isAsset(account)) total += balances.get(account.id) || 0;
  }
  return total;
}

/** Total owed across credit accounts, returned positive. */
export function totalDebt(state, throughISO = null) {
  const balances = accountBalances(state, throughISO);
  let total = 0;
  for (const account of state.accounts) {
    if (isCredit(account)) total += Math.min(0, balances.get(account.id) || 0);
  }
  return -total;
}

export function netWorth(state, throughISO = null) {
  let total = 0;
  for (const balance of accountBalances(state, throughISO).values()) total += balance;
  return total;
}

/** The span of months the ledger covers, always including the current month. */
export function ledgerMonths(state, throughMonth = currentMonth()) {
  const keys = [];
  for (const tx of ledgerTransactions(state)) keys.push(monthOf(tx.date));
  for (const key of Object.keys(state.budgets || {})) keys.push(key);
  keys.push(currentMonth());
  keys.push(throughMonth);
  const first = keys.reduce((min, k) => (compareMonths(k, min) < 0 ? k : min), keys[0]);
  const last = keys.reduce((max, k) => (compareMonths(k, max) > 0 ? k : max), keys[0]);
  return monthRange(first, compareMonths(throughMonth, last) > 0 ? throughMonth : last);
}

/**
 * Walk every month from the first to `throughMonth`, carrying envelope
 * balances forward. Returns a Map of monthKey -> month summary.
 *
 * Rollover rule: a positive envelope balance rolls into next month. A negative
 * one does not — overspending is absorbed by next month's Ready to assign,
 * which is what actually happened to the money.
 */
export function buildLedger(state, throughMonth = currentMonth()) {
  const months = ledgerMonths(state, throughMonth);
  const cardsByPaymentCategory = new Map();
  for (const category of state.categories) {
    if (category.kind === 'ccPayment' && category.accountId) {
      cardsByPaymentCategory.set(category.id, category.accountId);
    }
  }

  // Bucket every transaction once, by month, instead of re-scanning per month.
  const byMonth = new Map(months.map((m) => [m, []]));
  for (const tx of ledgerTransactions(state)) {
    const key = monthOf(tx.date);
    if (byMonth.has(key)) byMonth.get(key).push(tx);
  }

  const ledger = new Map();
  let previous = null;
  let fundsToDate = 0;
  let budgetedToDate = 0;
  let overspentCarried = 0;

  for (const month of months) {
    const transactions = byMonth.get(month) || [];
    const budgets = state.budgets?.[month] || {};

    const rows = new Map();
    for (const category of state.categories) {
      rows.set(category.id, {
        categoryId: category.id,
        rollover: previous ? Math.max(0, previous.rows.get(category.id)?.available ?? 0) : 0,
        budgeted: budgets[category.id] || 0,
        activity: 0,
        reserved: 0,
        available: 0,
      });
    }

    let income = 0;
    let startingFunds = 0;
    let spending = 0;

    for (const tx of transactions) {
      // An opening balance is money to budget, but it is not *income* — folding
      // it in would put a spike in every trend chart in the app.
      if (tx.kind === 'income') {
        if (tx.system) startingFunds += tx.amount;
        else income += tx.amount;
      }

      const row = tx.categoryId ? rows.get(tx.categoryId) : null;
      if (row) {
        row.activity += tx.amount;
        if (tx.kind === 'expense' && tx.amount < 0) spending += -tx.amount;
      }

      // Rule 2: spending on a card reserves the same cash for its payment.
      const account = state.accounts.find((a) => a.id === tx.accountId);
      if (account && isCredit(account) && tx.categoryId) {
        const category = state.categories.find((c) => c.id === tx.categoryId);
        if (category && category.kind === 'spending') {
          const paymentCategory = state.categories.find(
            (c) => c.kind === 'ccPayment' && c.accountId === account.id,
          );
          const target = paymentCategory ? rows.get(paymentCategory.id) : null;
          if (target) target.reserved += -tx.amount;
        }
      }
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

    const summary = {
      month,
      rows,
      income,
      startingFunds,
      spending,
      budgeted,
      overspent,
      cardsByPaymentCategory,
      /** Cash that has arrived but has not been given a job yet. */
      readyToAssign: fundsToDate - budgetedToDate - overspentCarried,
    };
    ledger.set(month, summary);

    overspentCarried += overspent;
    previous = summary;
  }

  return ledger;
}

/** Month summary with a stable empty shape when the month is out of range. */
export function monthSummary(state, month = currentMonth()) {
  const ledger = buildLedger(state, month);
  return (
    ledger.get(month) ?? {
      month,
      rows: new Map(),
      income: 0,
      startingFunds: 0,
      spending: 0,
      budgeted: 0,
      overspent: 0,
      readyToAssign: 0,
    }
  );
}

export function categoryRow(summary, categoryId) {
  return (
    summary.rows.get(categoryId) ?? {
      categoryId, rollover: 0, budgeted: 0, activity: 0, reserved: 0, available: 0,
    }
  );
}

export function readyToAssign(state, month = currentMonth()) {
  return monthSummary(state, month).readyToAssign;
}

/**
 * Runtime check of the identity documented at the top of this file. Surfaced
 * in Settings so a data-shaped bug is visible rather than silent.
 */
export function reconcile(state, month = currentMonth()) {
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
    /** Part of `available`, reported separately because it is the card link. */
    cardReserves,
    cash,
    debt: totalDebt(state, endOfMonth),
    expected,
    difference: expected - cash,
    balanced: Math.abs(expected - cash) < 1,
  };
}

function lastDayOf(month) {
  const [y, m] = month.split('-').map(Number);
  const day = new Date(y, m, 0).getDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

/** Total outflow per category over a month range, positive cents. */
export function spendingByCategory(state, fromMonth, toMonth) {
  const totals = new Map();
  for (const tx of ledgerTransactions(state)) {
    if (tx.kind !== 'expense' || !tx.categoryId) continue;
    const month = monthOf(tx.date);
    if (compareMonths(month, fromMonth) < 0 || compareMonths(month, toMonth) > 0) continue;
    totals.set(tx.categoryId, (totals.get(tx.categoryId) || 0) + -tx.amount);
  }
  return totals;
}

/** Income / spending / net per month, oldest first. */
export function monthlyTotals(state, months) {
  const ledger = buildLedger(state, months[months.length - 1]);
  return months.map((month) => {
    const summary = ledger.get(month);
    const income = summary?.income ?? 0;
    const spending = summary?.spending ?? 0;
    return { month, income, spending, net: income - spending };
  });
}

/** Transactions newest first, with optional filters. */
export function queryTransactions(state, filters = {}) {
  const { accountId, categoryId, month, search, kind, limit } = filters;
  const needle = search?.trim().toLowerCase();
  let rows = ledgerTransactions(state).filter((tx) => {
    if (accountId && tx.accountId !== accountId) return false;
    if (categoryId && tx.categoryId !== categoryId) return false;
    if (month && monthOf(tx.date) !== month) return false;
    if (kind && tx.kind !== kind) return false;
    if (needle) {
      const haystack = `${tx.payee} ${tx.memo}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1));
  if (limit) rows = rows.slice(0, limit);
  return rows;
}

/**
 * Suggested budget for a category: the average of the last `window` complete
 * months of spending, rounded up to the nearest dollar.
 */
export function suggestBudget(state, categoryId, month = currentMonth(), window = 3) {
  let total = 0;
  let counted = 0;
  for (let i = 1; i <= window; i++) {
    const key = addMonths(month, -i);
    const spent = spendingByCategory(state, key, key).get(categoryId) || 0;
    total += spent;
    counted++;
  }
  if (!counted || !total) return 0;
  return Math.ceil(total / counted / 100) * 100;
}
