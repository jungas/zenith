/**
 * Deterministic demo data. Seeded from a fixed constant so the same numbers
 * come out every time — screenshots, tests and the "load sample data" button
 * all agree.
 */

import { addMonths, currentMonth, daysInMonth, todayISO } from './dates.ts';
import { emptyState, ensurePaymentCategories, makeAccount, makeCategory, makeTransaction } from './model.ts';
import type { AppState, Category, Cents, CreditAccount, SeriesColor, Transaction } from './model.ts';
import { monthSummary } from './budget.ts';

/** One category's shape in the sample data, including how to fake its spending. */
interface CategorySpec {
  name: string;
  group: string;
  color: SeriesColor;
  budget: Cents;
  /** Transactions per month. */
  cadence: number;
  range: [Cents, Cents];
  /** Probability a charge lands on a card rather than chequing. */
  cardBias: number;
  fixed?: boolean;
  day?: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES: CategorySpec[] = [
  { name: 'Groceries',      group: 'Everyday',  color: 'series-3', budget: 62000,  cadence: 6,  range: [3200, 12500],  cardBias: 0.7 },
  { name: 'Dining out',     group: 'Everyday',  color: 'series-2', budget: 24000,  cadence: 5,  range: [1400, 7800],   cardBias: 0.85 },
  { name: 'Transport',      group: 'Everyday',  color: 'series-1', budget: 14000,  cadence: 4,  range: [600, 4200],    cardBias: 0.5 },
  { name: 'Fuel',           group: 'Everyday',  color: 'series-4', budget: 18000,  cadence: 3,  range: [3800, 7400],   cardBias: 0.9 },
  { name: 'Rent',           group: 'Bills',     color: 'series-7', budget: 165000, cadence: 1,  range: [165000, 165000], cardBias: 0, fixed: true, day: 1 },
  { name: 'Utilities',      group: 'Bills',     color: 'series-6', budget: 14500,  cadence: 1,  range: [9800, 17600],  cardBias: 0.2, day: 8 },
  { name: 'Phone',          group: 'Bills',     color: 'series-5', budget: 6500,   cadence: 1,  range: [6500, 6500],   cardBias: 1, fixed: true, day: 14 },
  { name: 'Internet',       group: 'Bills',     color: 'series-1', budget: 7900,   cadence: 1,  range: [7900, 7900],   cardBias: 1, fixed: true, day: 5 },
  { name: 'Insurance',      group: 'Bills',     color: 'series-8', budget: 21000,  cadence: 1,  range: [21000, 21000], cardBias: 0, fixed: true, day: 20 },
  { name: 'Subscriptions',  group: 'Lifestyle', color: 'series-5', budget: 4800,   cadence: 3,  range: [899, 1999],    cardBias: 1 },
  { name: 'Fees',           group: 'Bills',     color: 'series-8', budget: 1500,   cadence: 0,  range: [0, 0],         cardBias: 0 },
  { name: 'Shopping',       group: 'Lifestyle', color: 'series-2', budget: 20000,  cadence: 3,  range: [2200, 14000],  cardBias: 0.95 },
  { name: 'Health & fitness', group: 'Lifestyle', color: 'series-3', budget: 9500, cadence: 2,  range: [1800, 6500],   cardBias: 0.6 },
  { name: 'Travel fund',    group: 'Goals',     color: 'series-4', budget: 25000,  cadence: 0,  range: [0, 0],         cardBias: 0 },
  { name: 'Emergency fund', group: 'Goals',     color: 'series-6', budget: 0,      cadence: 0,  range: [0, 0],         cardBias: 0 },
];

const PAYEES: Record<string, string[]> = {
  Groceries: ['Fieldstone Market', 'GreenGrocer', 'Co-op Foods', 'Corner Deli'],
  'Dining out': ['Blue Kettle Cafe', 'Nori Bar', 'The Larder', 'Tostado'],
  Transport: ['Metro Transit', 'City Rail', 'Rideshare'],
  Fuel: ['Northgate Fuel', 'Loop Petrol'],
  Rent: ['Harbourview Lettings'],
  Utilities: ['Municipal Power', 'City Water'],
  Phone: ['Kestrel Mobile'],
  Internet: ['Fibrenet'],
  Insurance: ['Meridian Insurance'],
  Subscriptions: ['Streamly', 'Podpass', 'Cloud Drive'],
  Shopping: ['Anders & Co', 'Home Depot Yard', 'Bookshelf'],
  'Health & fitness': ['Riverside Gym', 'Pharmacy 24'],
};

export function seedState(
  { months = 4, now = new Date() }: { months?: number; now?: Date } = {},
): AppState {
  const random = mulberry32(20260725);
  const thisMonth = currentMonth(now);
  const firstMonth = addMonths(thisMonth, -(months - 1));
  const today = todayISO(now);

  const state = emptyState(now);
  state.settings.createdAt = new Date(now).toISOString();

  const checking = makeAccount({
    name: 'Everyday Checking', type: 'checking', openingBalance: 318000,
    openedOn: `${firstMonth}-01`, sort: 0,
  });
  const savings = makeAccount({
    name: 'Emergency Savings', type: 'savings', openingBalance: 950000,
    openedOn: `${firstMonth}-01`, sort: 1,
  });
  const wallet = makeAccount({
    name: 'Cash', type: 'cash', openingBalance: 12000,
    openedOn: `${firstMonth}-01`, sort: 2,
  });
  const ewallet = makeAccount({
    name: 'GCash', type: 'wallet', provider: 'GCash', openingBalance: 45000,
    openedOn: `${firstMonth}-01`, sort: 3,
  });
  const visa = makeAccount({
    name: 'Sapphire Visa', type: 'credit', openingBalance: 0,
    openedOn: `${firstMonth}-01`, creditLimit: 800000, apr: 0.2199,
    statementDay: 18, dueDay: 12, minPaymentRate: 0.02, minPaymentFloor: 3500, sort: 3,
  });
  const mastercard = makeAccount({
    name: 'Aurora Mastercard', type: 'credit',
    // Debt that predates the budget: nothing was ever set aside for it, so it
    // shows up as uncovered and is the app's first "pay this down" nudge.
    openingBalance: -124000,
    openedOn: `${firstMonth}-01`, creditLimit: 450000, apr: 0.2499,
    statementDay: 26, dueDay: 20, minPaymentRate: 0.025, minPaymentFloor: 2500, sort: 4,
  });
  state.accounts = [checking, savings, wallet, ewallet, visa, mastercard];

  const categories = CATEGORIES.map((spec, index) =>
    makeCategory({ name: spec.name, group: spec.group, color: spec.color, sort: index }),
  );
  state.categories = categories;
  const withPayments = ensurePaymentCategories(state);
  state.categories = withPayments.categories;

  const byName = new Map(categories.map((c) => [c.name, c]));
  const category = (name: string): Category => {
    const found = byName.get(name);
    if (!found) throw new Error(`seed: category "${name}" is missing`);
    return found;
  };
  const monthKeys: string[] = [];
  for (let i = 0; i < months; i++) monthKeys.push(addMonths(firstMonth, i));

  const transactions: Transaction[] = [];
  const pick = (list: string[]): string => list[Math.floor(random() * list.length) % list.length] ?? '';
  const between = ([min, max]: [Cents, Cents]): Cents =>
    min === max ? min : min + Math.round(random() * (max - min));

  for (const month of monthKeys) {
    const lastDay = daysInMonth(month);
    const isCurrent = month === thisMonth;
    const cutoff = isCurrent ? Number(today.slice(8, 10)) : lastDay;

    // Salary on the 1st and 15th.
    for (const day of [1, 15]) {
      if (day > cutoff) continue;
      transactions.push(makeTransaction({
        date: `${month}-${String(day).padStart(2, '0')}`,
        accountId: checking.id,
        categoryId: null,
        payee: 'Northwind Studio — salary',
        amount: 236500,
        kind: 'income',
        cleared: true,
      }));
    }

    for (const spec of CATEGORIES) {
      const target = category(spec.name);
      const count = spec.cadence;
      for (let i = 0; i < count; i++) {
        const day = spec.day ?? 2 + Math.floor(random() * (lastDay - 3));
        if (day > cutoff) continue;
        const useCard = random() < spec.cardBias;
        const cardAccount = random() < 0.65 ? visa : mastercard;
        // Small, frequent things get paid from the wallet, the way they do in
        // practice. Rent and insurance never do: a wallet holds pocket money,
        // and routing a large fixed bill through it would overdraw an account
        // that cannot go negative in real life.
        const walletSized = spec.cadence >= 2 && !spec.fixed && spec.range[1] <= 20_000;
        const cashAccount = !useCard && walletSized && random() < 0.4 ? ewallet.id : checking.id;
        transactions.push(makeTransaction({
          date: `${month}-${String(day).padStart(2, '0')}`,
          accountId: useCard ? cardAccount.id : cashAccount,
          categoryId: target.id,
          payee: pick(PAYEES[spec.name] ?? [spec.name]),
          amount: -between(spec.range),
          kind: 'expense',
          cleared: true,
        }));
      }
    }

    // Monthly wallet top-up, with the provider's cash-in fee as real spending.
    if (cutoff >= 6) {
      const transferId = `xfer_wallet_${month}`;
      transactions.push(
        makeTransaction({
          date: `${month}-06`, accountId: checking.id, categoryId: null,
          payee: 'Top up GCash', amount: -60000,
          kind: 'transfer', cleared: true, transferId,
        }),
        makeTransaction({
          date: `${month}-06`, accountId: ewallet.id, categoryId: null,
          payee: 'Top up from Everyday Checking', amount: 60000,
          kind: 'transfer', cleared: true, transferId,
        }),
        makeTransaction({
          date: `${month}-06`, accountId: checking.id, categoryId: category('Fees').id,
          payee: 'GCash — fee', amount: -1500,
          kind: 'expense', cleared: true, transferId,
        }),
      );
    }

    // Monthly transfer into savings.
    if (cutoff >= 16) {
      const transferId = `xfer_seed_${month}`;
      transactions.push(
        makeTransaction({
          date: `${month}-16`, accountId: checking.id, categoryId: null,
          payee: 'Transfer to Emergency Savings', amount: -40000,
          kind: 'transfer', cleared: true, transferId,
        }),
        makeTransaction({
          date: `${month}-16`, accountId: savings.id, categoryId: null,
          payee: 'Transfer from Everyday Checking', amount: 40000,
          kind: 'transfer', cleared: true, transferId,
        }),
      );
    }
  }

  state.transactions = transactions;

  // Budget every month, and assign the card payment envelopes so the seeded
  // history reads the way a maintained budget would.
  const budgets: Record<string, Record<string, Cents>> = {};
  for (const month of monthKeys) {
    const row: Record<string, Cents> = {};
    for (const spec of CATEGORIES) row[category(spec.name).id] = spec.budget;
    budgets[month] = row;
  }
  state.budgets = budgets;

  // Pay off each card's prior-month statement, except the pre-existing debt on
  // the Mastercard — that one is left to be dealt with in-app.
  const payments: Transaction[] = [];
  for (let i = 1; i < monthKeys.length; i++) {
    const month = monthKeys[i];
    const previous = monthKeys[i - 1];
    for (const card of [visa, mastercard] as CreditAccount[]) {
      const owed = transactions
        .filter((t) => t.accountId === card.id && t.date.startsWith(previous))
        .reduce((total, t) => total + -t.amount, 0);
      if (owed <= 0) continue;
      const day = card.id === visa.id ? 12 : 20;
      const date = `${month}-${String(day).padStart(2, '0')}`;
      if (date > today) continue;
      const transferId = `xfer_pay_${card.id}_${month}`;
      const paymentCategory = state.categories.find(
        (c) => c.kind === 'ccPayment' && c.accountId === card.id,
      );
      if (!paymentCategory) continue;
      payments.push(
        makeTransaction({
          date, accountId: checking.id, categoryId: paymentCategory.id,
          payee: `Payment to ${card.name}`, amount: -owed,
          kind: 'transfer', cleared: true, transferId,
        }),
        makeTransaction({
          date, accountId: card.id, categoryId: null,
          payee: `Payment from Everyday Checking`, amount: owed,
          kind: 'transfer', cleared: true, transferId,
        }),
      );
    }
  }
  state.transactions = [...transactions, ...payments];

  // The savings account's opening balance is budgetable cash, so park it in the
  // Emergency fund envelope rather than leaving thousands sitting unassigned.
  // A deliberate remainder is left over so the "give it a job" nudge is visible.
  const REMAINDER = 25_000;
  const emergency = category('Emergency fund');
  const spare = monthSummary(state, monthKeys[monthKeys.length - 1]).readyToAssign - REMAINDER;
  if (spare > 0) {
    const rounded = Math.round(spare / 100) * 100;
    state.budgets[firstMonth] = {
      ...state.budgets[firstMonth],
      [emergency.id]: rounded,
    };
  }

  return state;
}
