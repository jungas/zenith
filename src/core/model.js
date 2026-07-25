/**
 * Domain shapes and constructors.
 *
 * The whole app state is one JSON-serialisable object so it can be persisted,
 * exported and diffed trivially:
 *
 *   {
 *     version, settings,
 *     accounts:     Account[]
 *     categories:   Category[]
 *     budgets:      { 'YYYY-MM': { [categoryId]: cents } }
 *     transactions: Transaction[]
 *   }
 */

export const SCHEMA_VERSION = 1;

export const ACCOUNT_TYPES = /** @type {const} */ ({
  checking: { label: 'Checking', asset: true },
  savings: { label: 'Savings', asset: true },
  cash: { label: 'Cash', asset: true },
  credit: { label: 'Credit card', asset: false },
});

export const isCredit = (account) => account?.type === 'credit';
export const isAsset = (account) => ACCOUNT_TYPES[account?.type]?.asset === true;

/** Transaction kinds. `transfer` legs always come in linked pairs. */
export const TX_KINDS = /** @type {const} */ (['expense', 'income', 'transfer', 'adjustment']);

/** Category kinds. `ccPayment` categories are owned by a credit account. */
export const CATEGORY_KINDS = /** @type {const} */ (['spending', 'ccPayment']);

/**
 * Eight categorical slots, in the fixed order validated for colour-vision
 * deficiency (see README § Colour). Colour follows the entity, never its rank:
 * a category keeps its slot for life, so a filter that drops series never
 * repaints the survivors.
 */
export const CATEGORY_COLORS = [
  'series-1', 'series-2', 'series-3', 'series-4',
  'series-5', 'series-6', 'series-7', 'series-8',
];

export function newId(prefix = 'id') {
  const rand = (globalThis.crypto?.randomUUID?.() ?? `${Math.random()}`.slice(2))
    .replace(/-/g, '')
    .slice(0, 12);
  return `${prefix}_${rand}`;
}

export function makeAccount(patch = {}) {
  const type = patch.type && ACCOUNT_TYPES[patch.type] ? patch.type : 'checking';
  const base = {
    id: newId('acct'),
    name: 'New account',
    type,
    /** Cents. For credit accounts this is the debt already owed, stored negative. */
    openingBalance: 0,
    openedOn: patch.openedOn ?? null,
    note: '',
    archived: false,
    sort: 0,
  };
  const credit = type === 'credit'
    ? {
        creditLimit: 0,
        /** Annual percentage rate as a decimal: 0.1999 for 19.99%. */
        apr: 0,
        statementDay: 1,
        dueDay: 21,
        /** Minimum payment = max(minPaymentFloor, minPaymentRate × balance). */
        minPaymentRate: 0.02,
        minPaymentFloor: 2500,
      }
    : {};
  return { ...base, ...credit, ...patch, type };
}

export function makeCategory(patch = {}) {
  return {
    id: newId('cat'),
    name: 'New category',
    group: 'Everyday',
    kind: 'spending',
    color: CATEGORY_COLORS[0],
    /** Set only on `ccPayment` categories: the credit account they pay off. */
    accountId: null,
    note: '',
    archived: false,
    sort: 0,
    ...patch,
  };
}

export function makeTransaction(patch = {}) {
  return {
    id: newId('tx'),
    date: patch.date,
    accountId: null,
    categoryId: null,
    payee: '',
    memo: '',
    /** Signed cents, from the account's point of view. */
    amount: 0,
    kind: 'expense',
    cleared: false,
    /** Shared by the two legs of a transfer. */
    transferId: null,
    ...patch,
  };
}

export function emptyState(now = new Date()) {
  return {
    version: SCHEMA_VERSION,
    settings: {
      currency: 'USD',
      locale: 'en-US',
      theme: 'system',
      /** Warn when a card's utilisation crosses this. */
      utilizationWarn: 0.3,
      createdAt: now.toISOString(),
    },
    accounts: [],
    categories: [],
    budgets: {},
    transactions: [],
  };
}

/** The payment category that belongs to a credit account, if it exists. */
export function paymentCategoryFor(state, accountId) {
  return state.categories.find((c) => c.kind === 'ccPayment' && c.accountId === accountId) ?? null;
}

/**
 * Every credit account owns exactly one payment category. This is the hinge
 * between the two halves of the app: card spending funds this envelope, and
 * paying the card spends it back down.
 */
export function ensurePaymentCategories(state) {
  const next = { ...state, categories: [...state.categories] };
  for (const account of next.accounts) {
    if (!isCredit(account) || account.archived) continue;
    const existing = next.categories.find(
      (c) => c.kind === 'ccPayment' && c.accountId === account.id,
    );
    if (existing) {
      if (existing.name !== account.name) {
        next.categories = next.categories.map((c) =>
          c.id === existing.id ? { ...c, name: account.name } : c,
        );
      }
      continue;
    }
    next.categories.push(
      makeCategory({
        name: account.name,
        group: 'Credit card payments',
        kind: 'ccPayment',
        accountId: account.id,
        color: 'series-8',
        sort: 900,
      }),
    );
  }
  return next;
}

export function accountsById(state) {
  return new Map(state.accounts.map((a) => [a.id, a]));
}

export function categoriesById(state) {
  return new Map(state.categories.map((c) => [c.id, c]));
}

/** Spending categories, grouped for display, archived ones dropped. */
export function categoryGroups(state, { includeArchived = false } = {}) {
  const groups = new Map();
  const sorted = [...state.categories]
    .filter((c) => includeArchived || !c.archived)
    .sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
  for (const category of sorted) {
    if (!groups.has(category.group)) groups.set(category.group, []);
    groups.get(category.group).push(category);
  }
  // Card payments always sit last — they are funded by the groups above them.
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === 'Credit card payments') return 1;
    if (b === 'Credit card payments') return -1;
    return 0;
  });
}
