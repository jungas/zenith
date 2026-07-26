/**
 * Domain types, shapes and constructors.
 *
 * The whole app state is one JSON-serialisable object so it can be persisted,
 * exported and diffed trivially.
 */

declare global {
  interface Window {
    /**
     * Set by the single-file build. When true the app is one embedded HTML
     * document: there is no service worker to register, and the host owns the
     * light/dark switch.
     */
    __ZENITH_EMBEDDED__?: boolean;
  }
}

/** True when running as the single-file build rather than the full PWA. */
export const isEmbedded = (): boolean =>
  typeof window !== 'undefined' && window.__ZENITH_EMBEDDED__ === true;

/** Integer cents. Floats never touch a balance — see `core/money.ts`. */
export type Cents = number;
/** A calendar date, 'YYYY-MM-DD'. */
export type ISODate = string;
/** A calendar month, 'YYYY-MM'. */
export type MonthKey = string;

export const SCHEMA_VERSION = 1;

export type AssetAccountType = 'checking' | 'savings' | 'cash' | 'wallet';
export type AccountType = AssetAccountType | 'credit';
export type TxKind = 'expense' | 'income' | 'transfer' | 'adjustment';
export type CategoryKind = 'spending' | 'ccPayment';
export type ThemePreference = 'system' | 'light' | 'dark';

/** One of the eight validated categorical slots, plus the neutral "Other". */
export type SeriesColor =
  | 'series-1' | 'series-2' | 'series-3' | 'series-4'
  | 'series-5' | 'series-6' | 'series-7' | 'series-8'
  | 'series-neutral';

export const ACCOUNT_TYPES = {
  checking: { label: 'Checking', asset: true },
  savings: { label: 'Savings', asset: true },
  cash: { label: 'Cash', asset: true },
  wallet: { label: 'Digital wallet', asset: true },
  credit: { label: 'Credit card', asset: false },
} as const satisfies Record<AccountType, { label: string; asset: boolean }>;

/**
 * A digital wallet holds real money you can spend, so it is an asset account
 * like cash — not a payment method layered over a card. What makes it worth its
 * own type is the money movement around it: topping up from a bank and cashing
 * out again, often for a fee (see `addTransfer`'s `fee`).
 */
export const isWallet = (account: Account | null | undefined): account is AssetAccount =>
  account?.type === 'wallet';

/** Common providers, offered as suggestions rather than a closed list. */
export const WALLET_PROVIDERS = [
  'GCash', 'Maya', 'GrabPay', 'ShopeePay', 'PayPal', 'Wise', 'Revolut',
  'Apple Pay', 'Google Pay', 'Alipay', 'WeChat Pay', 'Venmo', 'Cash App',
] as const;

/**
 * Card issuers, offered as suggestions rather than a closed list — the region
 * rides along so "Metrobank" and "HSBC" are told apart in the picker. Philippine
 * banks come first because that is the market this app is used in; anything not
 * listed can still be typed.
 */
export const CARD_ISSUERS = [
  { name: 'BDO', region: 'Philippines' },
  { name: 'BPI', region: 'Philippines' },
  { name: 'Metrobank', region: 'Philippines' },
  { name: 'Security Bank', region: 'Philippines' },
  { name: 'UnionBank', region: 'Philippines' },
  { name: 'RCBC', region: 'Philippines' },
  { name: 'PNB', region: 'Philippines' },
  { name: 'EastWest Bank', region: 'Philippines' },
  { name: 'China Bank', region: 'Philippines' },
  { name: 'AUB', region: 'Philippines' },
  { name: 'Landbank', region: 'Philippines' },
  { name: 'HSBC Philippines', region: 'Philippines' },
  { name: 'American Express', region: 'International' },
  { name: 'Capital One', region: 'International' },
  { name: 'Chase', region: 'International' },
  { name: 'Citi', region: 'International' },
  { name: 'Discover', region: 'International' },
  { name: 'HSBC', region: 'International' },
  { name: 'Standard Chartered', region: 'International' },
] as const satisfies ReadonlyArray<{ name: string; region: string }>;

interface AccountBase {
  id: string;
  name: string;
  /** Cents. For credit accounts this is the debt already owed, stored negative. */
  openingBalance: Cents;
  openedOn: ISODate | null;
  note: string;
  archived: boolean;
  sort: number;
  /** Who runs the account: a wallet's provider ('GCash') or a card's issuing bank ('BPI'). */
  provider?: string;
}

export interface AssetAccount extends AccountBase {
  type: AssetAccountType;
}

export interface CreditAccount extends AccountBase {
  type: 'credit';
  creditLimit: Cents;
  /** Annual percentage rate as a decimal: 0.1999 for 19.99%. */
  apr: number;
  statementDay: number;
  dueDay: number;
  /** Minimum payment = max(minPaymentFloor, minPaymentRate × balance). */
  minPaymentRate: number;
  minPaymentFloor: Cents;
}

/**
 * A discriminated union, so the card-only terms cannot be read off a chequing
 * account without narrowing through `isCredit` first.
 */
export type Account = AssetAccount | CreditAccount;

export const isCredit = (account: Account | null | undefined): account is CreditAccount =>
  account?.type === 'credit';

export const isAsset = (account: Account | null | undefined): account is AssetAccount =>
  account != null && ACCOUNT_TYPES[account.type]?.asset === true;

export interface Category {
  id: string;
  name: string;
  group: string;
  kind: CategoryKind;
  color: SeriesColor;
  /** Set only on `ccPayment` categories: the credit account they pay off. */
  accountId: string | null;
  note: string;
  archived: boolean;
  sort: number;
}

export interface Transaction {
  id: string;
  date: ISODate;
  accountId: string | null;
  categoryId: string | null;
  payee: string;
  memo: string;
  /** Signed cents, from the account's point of view. */
  amount: Cents;
  kind: TxKind;
  cleared: boolean;
  /** Shared by the two legs of a transfer. */
  transferId: string | null;
  /** True on synthesised opening-balance rows, which are not editable. */
  system?: boolean;
}

/** Assigned amounts: month -> category -> cents. */
export type Budgets = Record<MonthKey, Record<string, Cents>>;

export interface Settings {
  currency: string;
  locale: string;
  theme: ThemePreference;
  /** Warn when a card's utilisation crosses this (0–1). */
  utilizationWarn: number;
  createdAt: string;
}

export interface AppState {
  version: number;
  settings: Settings;
  accounts: Account[];
  categories: Category[];
  budgets: Budgets;
  transactions: Transaction[];
}

/** Currency/locale pair threaded through every formatting call. */
export interface MoneyOptions {
  currency?: string;
  locale?: string;
  signed?: boolean;
  cents?: boolean;
}

/**
 * The eight categorical slots, in the fixed order validated for colour-vision
 * deficiency (see README § Colour). Colour follows the entity, never its rank:
 * a category keeps its slot for life, so a filter that drops series never
 * repaints the survivors.
 */
export const CATEGORY_COLORS = [
  'series-1', 'series-2', 'series-3', 'series-4',
  'series-5', 'series-6', 'series-7', 'series-8',
] as const satisfies readonly SeriesColor[];

export function newId(prefix = 'id'): string {
  const rand = (globalThis.crypto?.randomUUID?.() ?? `${Math.random()}`.slice(2))
    .replace(/-/g, '')
    .slice(0, 12);
  return `${prefix}_${rand}`;
}

const CREDIT_DEFAULTS = {
  creditLimit: 0,
  apr: 0,
  statementDay: 1,
  dueDay: 21,
  minPaymentRate: 0.02,
  minPaymentFloor: 2500,
} as const;

/** What callers may pass to `makeAccount`; card terms are ignored for non-cards. */
export type AccountDraft = Partial<Omit<CreditAccount, 'type'>> & { type?: AccountType };

export function makeAccount(patch: AccountDraft = {}): Account {
  const type: AccountType = patch.type && patch.type in ACCOUNT_TYPES ? patch.type : 'checking';
  const base: AccountBase = {
    id: newId('acct'),
    name: 'New account',
    openingBalance: 0,
    openedOn: patch.openedOn ?? null,
    note: '',
    archived: false,
    sort: 0,
  };
  if (type === 'credit') {
    return { ...base, ...CREDIT_DEFAULTS, ...patch, type: 'credit' };
  }
  // Drop any card terms a caller passed for a non-card account, so an asset
  // account can never carry a stale credit limit.
  const {
    creditLimit: _limit, apr: _apr, statementDay: _statement, dueDay: _due,
    minPaymentRate: _rate, minPaymentFloor: _floor, ...rest
  } = patch;
  return { ...base, ...rest, type };
}

export function makeCategory(patch: Partial<Category> = {}): Category {
  return {
    id: newId('cat'),
    name: 'New category',
    group: 'Everyday',
    kind: 'spending',
    color: CATEGORY_COLORS[0],
    accountId: null,
    note: '',
    archived: false,
    sort: 0,
    ...patch,
  };
}

export function makeTransaction(patch: Partial<Transaction> = {}): Transaction {
  return {
    id: newId('tx'),
    date: patch.date ?? '',
    accountId: null,
    categoryId: null,
    payee: '',
    memo: '',
    amount: 0,
    kind: 'expense',
    cleared: false,
    transferId: null,
    ...patch,
  };
}

export function emptyState(now: Date = new Date()): AppState {
  return {
    version: SCHEMA_VERSION,
    settings: {
      currency: 'USD',
      locale: 'en-US',
      theme: 'system',
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
export function paymentCategoryFor(state: AppState, accountId: string): Category | null {
  return state.categories.find((c) => c.kind === 'ccPayment' && c.accountId === accountId) ?? null;
}

/**
 * Every credit account owns exactly one payment category. This is the hinge
 * between the two halves of the app: card spending funds this envelope, and
 * paying the card spends it back down.
 */
export function ensurePaymentCategories(state: AppState): AppState {
  const next: AppState = { ...state, categories: [...state.categories] };
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

export function categoriesById(state: AppState): Map<string, Category> {
  return new Map(state.categories.map((c) => [c.id, c]));
}

/** Categories grouped for display, archived ones dropped by default. */
export function categoryGroups(
  state: AppState,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Array<[string, Category[]]> {
  const groups = new Map<string, Category[]>();
  const sorted = [...state.categories]
    .filter((c) => includeArchived || !c.archived)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  for (const category of sorted) {
    const bucket = groups.get(category.group);
    if (bucket) bucket.push(category);
    else groups.set(category.group, [category]);
  }
  // Card payments always sit last — they are funded by the groups above them.
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === 'Credit card payments') return 1;
    if (b === 'Credit card payments') return -1;
    return 0;
  });
}
