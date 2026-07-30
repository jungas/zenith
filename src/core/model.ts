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
export type DebtAccountType = 'credit' | 'loan';
export type AccountType = AssetAccountType | DebtAccountType;
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
  loan: { label: 'Loan', asset: false },
} as const satisfies Record<AccountType, { label: string; asset: boolean }>;

/**
 * Loan kinds worth naming, Philippine ones first. A label only — the maths is
 * the same whatever the loan is for.
 */
export const LOAN_KINDS = [
  'Personal loan', 'Auto loan', 'Housing loan', 'Pag-IBIG housing loan',
  'SSS salary loan', 'GSIS loan', 'Salary loan', 'Business loan',
  'Student loan', 'Motorcycle loan', 'Appliance loan',
] as const;

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
  /**
   * This card's own limit. Ignored while `sharedLimitId` is set — the shared
   * limit is the real one then — but kept, so leaving a group restores it.
   */
  creditLimit: Cents;
  /**
   * Annual percentage rate as a decimal: 0.1999 for 19.99%. Always stored
   * annually, whatever unit it was entered in — see `rateBasis`.
   */
  apr: number;
  /**
   * How the issuer quotes this card's rate.
   *
   * Philippine banks state a **monthly** rate — a statement says "3.5%", and
   * BSP's own cap is worded as "3% per month, 36% per annum". Storing the unit
   * lets the app show the figure that is printed on the statement instead of
   * one the cardholder has to convert in their head, while `apr` stays annual
   * so every calculation has a single basis. Absent means annual.
   */
  rateBasis?: 'annual' | 'monthly';
  statementDay: number;
  dueDay: number;
  /** Minimum payment = max(minPaymentFloor, minPaymentRate × balance). */
  minPaymentRate: number;
  minPaymentFloor: Cents;
  /** The shared credit limit this card draws on, if any. */
  sharedLimitId?: string | null;
}

/**
 * One credit limit shared by several cards.
 *
 * A bank that issues you a second card usually does not extend a second limit:
 * it hands you two cards that draw on the same one, so spending on either eats
 * the other's available credit. Treating them as two independent limits
 * overstates what you can spend by exactly the size of the limit, and understates
 * utilisation — the number credit scoring actually looks at.
 *
 * **Membership is restricted to one bank.** A shared limit is something an
 * issuer grants across its own products; two banks cannot share one, so the
 * group carries the bank and every member has to match it.
 */
export interface SharedLimit {
  id: string;
  /** Display name — defaults to the bank's, but a person may have two of these. */
  name: string;
  /** The issuing bank. Every member card's `provider` must equal this. */
  provider: string;
  /** The one limit the member cards draw on together. */
  creditLimit: Cents;
}

/**
 * A purchase converted into fixed monthly billings on a card.
 *
 * Ubiquitous in the Philippines: a ₱24,000 appliance becomes "3/12" on the
 * statement — the third of twelve monthly instalments. What the statement shows
 * is the instalment, but what you have committed to is the whole remaining run
 * of them, and that is the part a budget needs to see coming. Nine more months
 * of ₱2,000 is a fact about next year's budget, not a surprise to meet monthly.
 *
 * Tracking a plan **creates no transactions**. Each month's instalment already
 * arrives as an ordinary charge — typed in or imported from the statement — and
 * generating them here would bill everything twice. A plan is a schedule of
 * what is still to come, not a second copy of what has happened.
 */
export interface Installment {
  id: string;
  /** The credit card being billed. */
  accountId: string;
  description: string;
  /** What is billed each month. */
  monthlyAmount: Cents;
  /** How many monthly instalments the plan runs for. */
  months: number;
  /** The month the first instalment was billed. */
  startMonth: MonthKey;
  /**
   * The purchase price, when known. A plan billing more than this in total is
   * not 0% however it was sold, and the difference is what it costs.
   */
  principal: Cents | null;
  note: string;
}

/**
 * How often a bill comes round.
 *
 * Every cadence a household actually has, and nothing else: an arbitrary "every
 * N days" would let a bill drift off the calendar it is really tied to, and no
 * utility bills on the 40th day.
 */
export type BillCadence = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'semiannual' | 'annual';

export const BILL_CADENCES = {
  weekly: { label: 'Weekly', days: 7, months: 0, perYear: 52 },
  fortnightly: { label: 'Every 2 weeks', days: 14, months: 0, perYear: 26 },
  monthly: { label: 'Monthly', days: 0, months: 1, perYear: 12 },
  quarterly: { label: 'Quarterly', days: 0, months: 3, perYear: 4 },
  semiannual: { label: 'Every 6 months', days: 0, months: 6, perYear: 2 },
  annual: { label: 'Yearly', days: 0, months: 12, perYear: 1 },
} as const satisfies Record<
  BillCadence,
  { label: string; days: number; months: number; perYear: number }
>;

/**
 * A bill that comes round again: rent, electricity, a subscription, insurance.
 *
 * A bill is a **schedule, not a ledger**. Tracking one creates no transactions —
 * for the same reason an instalment plan creates none. What it stores is when
 * the money is expected to leave and what it is expected to cost; whether a
 * given month's bill was actually paid is read back out of the ledger, from a
 * transaction tagged with this bill's id and the due date it settled.
 *
 * That direction matters. A schedule that generated its own transactions would
 * claim money had moved when nobody paid anything, and would have to be
 * corrected by hand every time the real payment differed. Deriving instead
 * means a bill can be added years after the fact, edited freely, or deleted
 * outright, and the account balances never move.
 *
 * The occurrences themselves are derived too: a cadence and an anchor date
 * generate every due date forwards and backwards, so nothing has to be rolled
 * over at the end of a month.
 */
export interface Bill {
  id: string;
  /** What it is: 'Electricity', 'Netflix'. */
  name: string;
  /** Who is paid, when that differs from the name. */
  payee: string;
  /**
   * What it costs each time. For a `variable` bill this is the estimate to fall
   * back on until there are real payments to average.
   */
  amount: Cents;
  /** True when the figure moves month to month — a metered utility bill. */
  variable: boolean;
  cadence: BillCadence;
  /**
   * The anchor: one real due date. Every other occurrence is this one stepped
   * by the cadence, so the day of the month (or the weekday) comes from here.
   */
  startDate: ISODate;
  /** The last due date, when the commitment ends. */
  endDate: ISODate | null;
  /** The envelope it is budgeted to. */
  categoryId: string | null;
  /** Where it is normally paid from — an asset account, or the card it sits on. */
  accountId: string | null;
  /** Leaves automatically. Still needs funding; it just needs no action. */
  autopay: boolean;
  /**
   * Occurrences deliberately not paid — a month skipped, a holiday from a gym
   * membership. Recorded by due date so the rest of the schedule is untouched.
   */
  skipped: ISODate[];
  archived: boolean;
  note: string;
}

/**
 * Money borrowed and repaid in fixed monthly amounts.
 *
 * Unlike a card, a loan is not spent on: the principal arrives once and the
 * balance only falls. What it needs from the budget is the opposite of a card's
 * — not a reserve that grows with spending, but a monthly amount set aside
 * before the due date. It gets a payment envelope for exactly that reason, and
 * for one more: paying a loan moves cash out of an asset account into a
 * liability, and without an envelope to draw down, the identity in
 * `core/budget.ts` would not hold.
 */
export interface LoanAccount extends AccountBase {
  type: 'loan';
  /** What was borrowed. */
  principal: Cents;
  /** Annual rate as a decimal, however it was quoted — see `rateBasis`. */
  apr: number;
  rateBasis?: 'annual' | 'monthly';
  /** The fixed monthly amortisation. */
  monthlyPayment: Cents;
  /** How many monthly payments the loan runs for. */
  termMonths: number;
  /** Day of the month the payment falls due. */
  dueDay: number;
  /** The month the first payment was due. */
  startMonth: MonthKey;
  /** What the loan is for: 'Auto loan', 'Pag-IBIG housing loan'. */
  kind?: string;
}

/**
 * A discriminated union, so the card-only terms cannot be read off a chequing
 * account without narrowing through `isCredit` first.
 */
export type Account = AssetAccount | CreditAccount | LoanAccount;

export const isCredit = (account: Account | null | undefined): account is CreditAccount =>
  account?.type === 'credit';

export const isLoan = (account: Account | null | undefined): account is LoanAccount =>
  account?.type === 'loan';

/**
 * Anything owed. Both kinds carry a payment envelope and stay out of
 * `cashOnHand`; what differs is how the balance gets there.
 */
export const isDebt = (account: Account | null | undefined): account is CreditAccount | LoanAccount =>
  isCredit(account) || isLoan(account);

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
  /**
   * The date the bank posted this, as printed on the statement it came from —
   * the posting date when a statement prints both dates, otherwise the single
   * date it prints. Null when nothing has said: a transaction typed in by hand
   * has no bank record behind it yet.
   *
   * `date` is when the money moved and is the only date the budget uses; this
   * one is the bank's own record of the row, which is why it is stored even when
   * the two are equal. It is what a re-imported statement is matched against, so
   * the same row cannot arrive twice however far `date` has since been edited —
   * see `findDuplicate` in `core/statement-import.ts`.
   */
  postedDate?: ISODate | null;
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
  /**
   * The recurring bill this settles, when it settles one. Together with
   * `billDue` it is the receipt that marks one occurrence paid — see `Bill`.
   */
  billId?: string | null;
  /**
   * Which occurrence was paid, by its due date. Stored rather than inferred
   * from the transaction's own date: a bill paid three days early belongs to
   * the occurrence it settles, not to whichever window the calendar puts it in.
   */
  billDue?: ISODate | null;
}

/** Assigned amounts: month -> category -> cents. */
export type Budgets = Record<MonthKey, Record<string, Cents>>;

/**
 * Which reminders the device may raise, and how far ahead. Notifications are
 * generated on this device from the budget itself — see `core/reminders.ts` for
 * what each flag produces and `src/reminders.ts` for how it is delivered.
 */
export interface ReminderSettings {
  /** Master switch. Off until permission has actually been granted. */
  enabled: boolean;
  /** Days before a due date to send the first nudge; 0 sends only on the day. */
  leadDays: number;
  /** Payment due, due today, and overdue. */
  payments: boolean;
  /** The day a card's statement closes. */
  statements: boolean;
  /** Card debt with no cash set aside for it. */
  unfunded: boolean;
  /** Recurring bills coming due, and ones that have gone past. */
  bills: boolean;
}

export const REMINDER_DEFAULTS: ReminderSettings = {
  enabled: false,
  leadDays: 3,
  payments: true,
  statements: false,
  unfunded: true,
  bills: true,
};

export interface Settings {
  currency: string;
  locale: string;
  theme: ThemePreference;
  /** Warn when a card's utilisation crosses this (0–1). */
  utilizationWarn: number;
  reminders: ReminderSettings;
  createdAt: string;
}

export interface AppState {
  version: number;
  settings: Settings;
  accounts: Account[];
  categories: Category[];
  budgets: Budgets;
  transactions: Transaction[];
  /** Credit limits shared by two or more cards from the same bank. */
  sharedLimits: SharedLimit[];
  /** Purchases being billed in fixed monthly instalments. */
  installments: Installment[];
  /** Recurring bills: when money is expected to leave, and for what. */
  bills: Bill[];
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
  sharedLimitId: null,
  rateBasis: 'annual',
} as const;

const LOAN_DEFAULTS = {
  principal: 0,
  apr: 0,
  rateBasis: 'annual',
  monthlyPayment: 0,
  termMonths: 0,
  dueDay: 5,
  startMonth: '',
} as const;

/** What callers may pass to `makeAccount`; terms are ignored for other types. */
export type AccountDraft = Partial<Omit<CreditAccount, 'type'>> &
  Partial<Omit<LoanAccount, 'type'>> & { type?: AccountType };

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
    const { principal: _p, monthlyPayment: _mp, termMonths: _tm, startMonth: _sm, kind: _k, ...card } = patch;
    return { ...base, ...CREDIT_DEFAULTS, ...card, type: 'credit' };
  }
  if (type === 'loan') {
    const {
      creditLimit: _cl, statementDay: _sd, minPaymentRate: _mr, minPaymentFloor: _mf,
      sharedLimitId: _sl, ...loan
    } = patch;
    return { ...base, ...LOAN_DEFAULTS, ...loan, type: 'loan' };
  }
  // Drop any card terms a caller passed for a non-card account, so an asset
  // account can never carry a stale credit limit.
  const {
    creditLimit: _limit, apr: _apr, statementDay: _statement, dueDay: _due,
    minPaymentRate: _rate, minPaymentFloor: _floor, sharedLimitId: _shared,
    rateBasis: _basis, principal: _principal, monthlyPayment: _monthly,
    termMonths: _term, startMonth: _start, kind: _kind, ...rest
  } = patch;
  return { ...base, ...rest, type };
}

export function makeSharedLimit(patch: Partial<SharedLimit> = {}): SharedLimit {
  return {
    id: newId('slim'),
    name: 'Shared limit',
    provider: '',
    creditLimit: 0,
    ...patch,
  };
}

export function makeInstallment(patch: Partial<Installment> = {}): Installment {
  return {
    id: newId('inst'),
    accountId: '',
    description: 'Instalment plan',
    monthlyAmount: 0,
    months: 0,
    startMonth: '',
    principal: null,
    note: '',
    ...patch,
  };
}

export function makeBill(patch: Partial<Bill> = {}): Bill {
  const { skipped, ...rest } = patch;
  return {
    id: newId('bill'),
    name: 'New bill',
    payee: '',
    amount: 0,
    variable: false,
    cadence: 'monthly',
    startDate: '',
    endDate: null,
    categoryId: null,
    accountId: null,
    autopay: false,
    archived: false,
    note: '',
    ...rest,
    // Copied rather than shared: a caller's array must not become the bill's.
    skipped: [...(skipped ?? [])],
  };
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
    // Normalised rather than trusted: an empty date input hands over `''`, and
    // an empty string is a date no comparison would ever match, which would
    // quietly cost the duplicate check the anchor it exists for.
    postedDate: patch.postedDate || null,
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
      reminders: { ...REMINDER_DEFAULTS },
      createdAt: now.toISOString(),
    },
    accounts: [],
    categories: [],
    budgets: {},
    transactions: [],
    sharedLimits: [],
    installments: [],
    bills: [],
  };
}

/** The payment category that belongs to a credit account, if it exists. */
export function paymentCategoryFor(state: AppState, accountId: string): Category | null {
  return state.categories.find((c) => c.kind === 'ccPayment' && c.accountId === accountId) ?? null;
}

/**
 * Every debt account owns exactly one payment category. This is the hinge
 * between the two halves of the app: card spending funds this envelope, and
 * paying the card spends it back down. A loan uses the same envelope for the
 * other direction — you budget into it monthly, and the payment draws it down.
 */
export function ensurePaymentCategories(state: AppState): AppState {
  const next: AppState = { ...state, categories: [...state.categories] };
  for (const account of next.accounts) {
    if (!isDebt(account) || account.archived) continue;
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
        group: isLoan(account) ? 'Loan payments' : 'Credit card payments',
        kind: 'ccPayment',
        accountId: account.id,
        color: 'series-8',
        sort: 900,
      }),
    );
  }
  return next;
}

/* ── Shared credit limits ─────────────────────────────────────────────── */

export function sharedLimitById(state: AppState, id: string | null | undefined): SharedLimit | null {
  if (!id) return null;
  return state.sharedLimits?.find((limit) => limit.id === id) ?? null;
}

/** The shared limit a card draws on, or null when it has its own. */
export function sharedLimitFor(state: AppState, card: Account | null | undefined): SharedLimit | null {
  if (!isCredit(card)) return null;
  return sharedLimitById(state, card.sharedLimitId);
}

/** Every card drawing on a shared limit, in display order. */
export function sharedLimitMembers(state: AppState, limitId: string): CreditAccount[] {
  return state.accounts
    .filter((a): a is CreditAccount => isCredit(a) && a.sharedLimitId === limitId)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

/** The other cards on the same limit as this one. */
export function sharedLimitSiblings(state: AppState, card: CreditAccount): CreditAccount[] {
  if (!card.sharedLimitId) return [];
  return sharedLimitMembers(state, card.sharedLimitId).filter((other) => other.id !== card.id);
}

/** Bank names compare case- and spacing-insensitively: "BPI " is "bpi". */
export const sameBank = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/**
 * May this card join that shared limit?
 *
 * The rule is the bank's: an issuer shares a limit across its own cards, so a
 * card can only join a group carrying the same `provider`. A card with no bank
 * recorded cannot join anything, because there is nothing to check it against.
 */
export function canJoinSharedLimit(
  state: AppState,
  card: Account | null | undefined,
  limitId: string,
): boolean {
  if (!isCredit(card)) return false;
  const limit = sharedLimitById(state, limitId);
  if (!limit) return false;
  return Boolean(card.provider?.trim()) && sameBank(card.provider, limit.provider);
}

/** The shared limits this card is eligible to join, by its bank. */
export function eligibleSharedLimits(state: AppState, card: Account | null | undefined): SharedLimit[] {
  if (!isCredit(card) || !card.provider?.trim()) return [];
  return (state.sharedLimits ?? []).filter((limit) => sameBank(limit.provider, card.provider));
}

/**
 * The limit a card actually draws on: the shared one when it is in a group,
 * its own otherwise. Every utilisation figure in the app goes through this.
 */
export function effectiveCreditLimit(state: AppState, card: CreditAccount): Cents {
  return sharedLimitFor(state, card)?.creditLimit ?? card.creditLimit ?? 0;
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
  // Debt payments always sit last — they are funded by the groups above them.
  const debtGroups = ['Loan payments', 'Credit card payments'];
  return [...groups.entries()].sort(([a], [b]) => {
    const left = debtGroups.indexOf(a);
    const right = debtGroups.indexOf(b);
    if (left >= 0 && right >= 0) return left - right;
    if (left >= 0) return 1;
    if (right >= 0) return -1;
    return 0;
  });
}
