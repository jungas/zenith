/**
 * State transitions. Every function takes state and returns *new* state —
 * nothing here mutates, so undo is just keeping the previous object.
 */

import {
  canJoinSharedLimit, ensurePaymentCategories, isCredit, isDebt, makeAccount, makeCategory,
  makeInstallment, makeSharedLimit, makeTransaction, newId, paymentCategoryFor, sameBank,
  sharedLimitById,
} from './model.ts';
import type {
  Account, AccountDraft, AppState, Budgets, Category, Cents, Installment, ISODate, MonthKey,
  SharedLimit, Transaction,
} from './model.ts';
import { todayISO } from './dates.ts';

/** Fields a caller may set when recording a transaction. */
export type TransactionDraft = Partial<Transaction>;

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amount: Cents;
  date?: ISODate;
  payee?: string;
  memo?: string;
  cleared?: boolean;
  /**
   * A charge the sending account pays on top of the amount moved — a wallet
   * cash-out fee, a wire fee. Recorded as ordinary categorised spending, not as
   * an adjustment, because that is exactly what it is: money that left and is
   * not coming back.
   */
  fee?: Cents;
  /** Where the fee is budgeted. Required for the fee to be recorded. */
  feeCategoryId?: string | null;
}

export interface PaymentInput {
  cardId: string;
  fromAccountId: string;
  amount: Cents;
  date?: ISODate;
  memo?: string;
}

/* ── Accounts ─────────────────────────────────────────────────────────── */

export function addAccount(state: AppState, patch: AccountDraft): AppState {
  const account = makeAccount({
    ...patch,
    openedOn: patch.openedOn || todayISO(),
    sort: state.accounts.length,
  });
  return tidySharedLimits(ensurePaymentCategories({ ...state, accounts: [...state.accounts, account] }));
}

export function updateAccount(state: AppState, accountId: string, patch: AccountDraft): AppState {
  const accounts = state.accounts.map((account) => {
    if (account.id !== accountId) return account;
    // The type discriminant is fixed at creation. Re-running the constructor
    // also strips card terms if this account is not a card.
    return makeAccount({ ...account, ...patch, type: account.type });
  });
  return tidySharedLimits(ensurePaymentCategories({ ...state, accounts }));
}

/**
 * Deleting an account removes its transactions and, for a card, its payment
 * envelope. Any transfer that pointed at it loses its partner leg too —
 * a half-transfer would silently unbalance every total in the app.
 */
export function deleteAccount(state: AppState, accountId: string): AppState {
  const doomedTransfers = new Set(
    state.transactions.filter((t) => t.accountId === accountId && t.transferId).map((t) => t.transferId),
  );
  const transactions = state.transactions.filter(
    (t) => t.accountId !== accountId && !(t.transferId && doomedTransfers.has(t.transferId)),
  );
  const categories = state.categories.filter(
    (c) => !(c.kind === 'ccPayment' && c.accountId === accountId),
  );
  const removedCategoryIds = new Set(
    state.categories.filter((c) => c.kind === 'ccPayment' && c.accountId === accountId).map((c) => c.id),
  );
  return tidySharedLimits({
    ...state,
    accounts: state.accounts.filter((a) => a.id !== accountId),
    // A plan bills a card that no longer exists; it goes with it.
    installments: (state.installments ?? []).filter((plan) => plan.accountId !== accountId),
    categories,
    budgets: stripCategories(state.budgets, removedCategoryIds),
    transactions: transactions.map((t) =>
      t.categoryId && removedCategoryIds.has(t.categoryId) ? { ...t, categoryId: null } : t,
    ),
  });
}

/* ── Shared credit limits ─────────────────────────────────────────────── */

/**
 * Create a shared limit and put a card on it.
 *
 * The card's bank becomes the group's bank, which is what every later
 * membership check compares against. A card with no bank recorded cannot start
 * one — there would be nothing to hold the others to.
 */
export function createSharedLimit(
  state: AppState,
  cardId: string,
  { name, creditLimit }: { name?: string; creditLimit: Cents },
): AppState {
  const card = state.accounts.find((a) => a.id === cardId);
  if (!isCredit(card)) return state;
  const provider = (card.provider ?? '').trim();
  if (!provider) return state;

  const limit = makeSharedLimit({
    name: name?.trim() || `${provider} shared limit`,
    provider,
    creditLimit: Math.max(0, Math.round(creditLimit)),
  });

  return {
    ...state,
    sharedLimits: [...(state.sharedLimits ?? []), limit],
    accounts: state.accounts.map((a) =>
      a.id === cardId && isCredit(a) ? { ...a, sharedLimitId: limit.id } : a,
    ),
  };
}

/**
 * Put a card onto an existing shared limit.
 *
 * Refused when the banks differ. That is the whole constraint, and it is
 * enforced here rather than only in the form, so an import or a hand-edited
 * backup cannot produce a group spanning two issuers.
 */
export function joinSharedLimit(state: AppState, cardId: string, limitId: string): AppState {
  const card = state.accounts.find((a) => a.id === cardId);
  if (!canJoinSharedLimit(state, card, limitId)) return state;
  return {
    ...state,
    accounts: state.accounts.map((a) =>
      a.id === cardId && isCredit(a) ? { ...a, sharedLimitId: limitId } : a,
    ),
  };
}

/**
 * Take a card off its shared limit.
 *
 * It leaves with a limit of its own: the group's, unless the card still
 * remembers a figure from before it joined. Leaving with a limit of zero would
 * read as "no limit set" and quietly stop tracking utilisation.
 */
export function leaveSharedLimit(state: AppState, cardId: string): AppState {
  const card = state.accounts.find((a) => a.id === cardId);
  if (!isCredit(card) || !card.sharedLimitId) return state;
  const limit = sharedLimitById(state, card.sharedLimitId);

  const accounts = state.accounts.map((a) =>
    a.id === cardId && isCredit(a)
      ? { ...a, sharedLimitId: null, creditLimit: a.creditLimit || limit?.creditLimit || 0 }
      : a,
  );
  return tidySharedLimits({ ...state, accounts });
}

/**
 * Put two cards on one limit, whichever of them already has a group.
 *
 * This is what the form actually offers — "shares its limit with *that* card" —
 * because a shared limit is something a person recognises by the cards on it,
 * not by a group that exists in its own right. Creating the group is an
 * implementation detail of answering that question.
 */
export function shareLimitWith(
  state: AppState,
  cardId: string,
  otherCardId: string,
  { creditLimit }: { creditLimit?: Cents } = {},
): AppState {
  const card = state.accounts.find((a) => a.id === cardId);
  const other = state.accounts.find((a) => a.id === otherCardId);
  if (!isCredit(card) || !isCredit(other) || card.id === other.id) return state;
  // The rule again, at the only other door into a group.
  if (!card.provider?.trim() || !sameBank(card.provider, other.provider)) return state;

  if (other.sharedLimitId) {
    let next = joinSharedLimit(state, cardId, other.sharedLimitId);
    if (creditLimit != null) {
      next = updateSharedLimit(next, other.sharedLimitId, {
        creditLimit: Math.max(0, Math.round(creditLimit)),
      });
    }
    return next;
  }

  const before = new Set((state.sharedLimits ?? []).map((limit) => limit.id));
  let next = createSharedLimit(state, cardId, {
    creditLimit: creditLimit ?? other.creditLimit ?? card.creditLimit ?? 0,
  });
  const created = (next.sharedLimits ?? []).find((limit) => !before.has(limit.id));
  if (!created) return state;
  return tidySharedLimits(joinSharedLimit(next, otherCardId, created.id));
}

export function updateSharedLimit(
  state: AppState,
  limitId: string,
  patch: Partial<Omit<SharedLimit, 'id'>>,
): AppState {
  return {
    ...state,
    sharedLimits: (state.sharedLimits ?? []).map((limit) =>
      limit.id === limitId ? { ...limit, ...patch, id: limit.id } : limit,
    ),
  };
}

/**
 * Keep the groups honest after any change to the accounts.
 *
 * Two things can go stale. A card whose bank was edited no longer belongs to
 * its group, so the link goes — the alternative is a group silently spanning
 * two issuers. And a group left with one card is not shared by anything, so it
 * dissolves and hands its limit back to the survivor rather than taking the
 * figure with it.
 */
export function tidySharedLimits(state: AppState): AppState {
  const limits = state.sharedLimits ?? [];
  if (!limits.length) return state;

  let accounts = state.accounts.map((account) => {
    if (!isCredit(account) || !account.sharedLimitId) return account;
    const limit = limits.find((entry) => entry.id === account.sharedLimitId);
    if (limit && sameBank(account.provider, limit.provider)) return account;
    return {
      ...account,
      sharedLimitId: null,
      creditLimit: account.creditLimit || limit?.creditLimit || 0,
    };
  });

  const survivors: SharedLimit[] = [];
  for (const limit of limits) {
    const members = accounts.filter((a) => isCredit(a) && a.sharedLimitId === limit.id);
    if (members.length >= 2) {
      survivors.push(limit);
      continue;
    }
    // One card, or none: dissolve, leaving the limit with whoever is left.
    accounts = accounts.map((a) =>
      isCredit(a) && a.sharedLimitId === limit.id
        ? { ...a, sharedLimitId: null, creditLimit: limit.creditLimit || a.creditLimit || 0 }
        : a,
    );
  }

  if (survivors.length === limits.length && accounts.every((a, i) => a === state.accounts[i])) {
    return state;
  }
  return { ...state, accounts, sharedLimits: survivors };
}

/* ── Instalment plans ─────────────────────────────────────────────────── */

/**
 * Track a purchase being billed monthly.
 *
 * Only on a credit card, and only with a term and a monthly amount — a plan
 * missing either cannot say what is still to come, which is the only reason it
 * exists.
 */
export function addInstallment(state: AppState, patch: Partial<Installment>): AppState {
  const card = state.accounts.find((a) => a.id === patch.accountId);
  if (!isCredit(card)) return state;
  const plan = makeInstallment(patch);
  if (plan.months < 1 || plan.monthlyAmount <= 0 || !plan.startMonth) return state;
  return { ...state, installments: [...(state.installments ?? []), plan] };
}

export function updateInstallment(
  state: AppState,
  installmentId: string,
  patch: Partial<Installment>,
): AppState {
  return {
    ...state,
    installments: (state.installments ?? []).map((plan) =>
      plan.id === installmentId ? { ...plan, ...patch, id: plan.id } : plan,
    ),
  };
}

export function deleteInstallment(state: AppState, installmentId: string): AppState {
  return {
    ...state,
    installments: (state.installments ?? []).filter((plan) => plan.id !== installmentId),
  };
}

/* ── Categories ───────────────────────────────────────────────────────── */

export function addCategory(state: AppState, patch: Partial<Category>): AppState {
  const category = makeCategory({ ...patch, sort: state.categories.length });
  return { ...state, categories: [...state.categories, category] };
}

export function updateCategory(state: AppState, categoryId: string, patch: Partial<Category>): AppState {
  return {
    ...state,
    categories: state.categories.map((c) => (c.id === categoryId ? { ...c, ...patch } : c)),
  };
}

/**
 * Payment envelopes are structural — they are deleted with their card, never
 * on their own, or card spending would have nowhere to reserve cash.
 */
export function deleteCategory(state: AppState, categoryId: string): AppState {
  const category = state.categories.find((c) => c.id === categoryId);
  if (!category || category.kind === 'ccPayment') return state;
  return {
    ...state,
    categories: state.categories.filter((c) => c.id !== categoryId),
    budgets: stripCategories(state.budgets, new Set([categoryId])),
    transactions: state.transactions.map((t) =>
      t.categoryId === categoryId ? { ...t, categoryId: null } : t,
    ),
  };
}

function stripCategories(budgets: Budgets, categoryIds: Set<string>): Budgets {
  const next: Budgets = {};
  for (const [month, row] of Object.entries(budgets ?? {})) {
    const kept: Record<string, Cents> = {};
    for (const [categoryId, cents] of Object.entries(row)) {
      if (!categoryIds.has(categoryId)) kept[categoryId] = cents;
    }
    next[month] = kept;
  }
  return next;
}

/* ── Budgeting ────────────────────────────────────────────────────────── */

export function setBudget(state: AppState, month: MonthKey, categoryId: string, cents: Cents): AppState {
  const row: Record<string, Cents> = { ...(state.budgets[month] ?? {}) };
  if (!cents) delete row[categoryId];
  else row[categoryId] = Math.round(cents);
  return { ...state, budgets: { ...state.budgets, [month]: row } };
}

/** Move assigned money from one envelope to another within a month. */
export function moveBudget(
  state: AppState,
  month: MonthKey,
  fromCategoryId: string,
  toCategoryId: string,
  cents: Cents,
): AppState {
  if (!cents || fromCategoryId === toCategoryId) return state;
  const row = state.budgets[month] ?? {};
  let next = setBudget(state, month, fromCategoryId, (row[fromCategoryId] ?? 0) - cents);
  next = setBudget(next, month, toCategoryId, (next.budgets[month]?.[toCategoryId] ?? 0) + cents);
  return next;
}

/* ── Transactions ─────────────────────────────────────────────────────── */

/**
 * Record spending or income.
 * `amount` is signed cents from the account's point of view: an expense on a
 * credit card is negative, and increases what the card owes.
 */
export function addTransaction(state: AppState, patch: TransactionDraft): AppState {
  const kind = patch.kind ?? ((patch.amount ?? 0) > 0 ? 'income' : 'expense');
  const transaction = makeTransaction({
    ...patch,
    kind,
    date: patch.date || todayISO(),
    categoryId: kind === 'income' ? null : patch.categoryId ?? null,
  });
  return { ...state, transactions: [...state.transactions, transaction] };
}

export function updateTransaction(state: AppState, transactionId: string, patch: TransactionDraft): AppState {
  const existing = state.transactions.find((t) => t.id === transactionId);
  if (!existing) return state;

  // Editing one leg of a transfer must keep the mirror leg in step. Only the
  // two transfer legs mirror each other: a fee attached to the same transferId
  // is an expense in its own right and must keep its own amount.
  if (existing.transferId && existing.kind === 'transfer' && (patch.amount != null || patch.date)) {
    const transactions = state.transactions.map((t) => {
      if (t.id === transactionId) return { ...t, ...patch };
      if (t.transferId !== existing.transferId) return t;
      if (t.kind !== 'transfer') {
        return patch.date ? { ...t, date: patch.date } : t;
      }
      return {
        ...t,
        ...(patch.date ? { date: patch.date } : {}),
        ...(patch.amount != null ? { amount: -patch.amount } : {}),
      };
    });
    return { ...state, transactions };
  }

  return {
    ...state,
    transactions: state.transactions.map((t) => (t.id === transactionId ? { ...t, ...patch } : t)),
  };
}

export function deleteTransaction(state: AppState, transactionId: string): AppState {
  const existing = state.transactions.find((t) => t.id === transactionId);
  if (!existing) return state;
  const transactions = existing.transferId
    ? state.transactions.filter((t) => t.transferId !== existing.transferId)
    : state.transactions.filter((t) => t.id !== transactionId);
  return { ...state, transactions };
}

/**
 * Move money between two accounts as a linked pair of legs.
 *
 * When the destination is a credit card this *is* a card payment: the outflow
 * leg is categorised to the card's payment envelope, which draws down the cash
 * that card spending reserved. That single line is the whole connection
 * between the budget and the debt.
 */
export function addTransfer(
  state: AppState,
  {
    fromAccountId, toAccountId, amount, date, payee, memo, cleared, fee, feeCategoryId,
  }: TransferInput,
): AppState {
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId || !amount) return state;
  const cents = Math.abs(Math.round(amount));
  const transferId = newId('xfer');
  const when = date || todayISO();
  const to: Account | undefined = state.accounts.find((a) => a.id === toAccountId);
  const from: Account | undefined = state.accounts.find((a) => a.id === fromAccountId);

  // Any debt account: paying a card *or* a loan spends its payment envelope.
  // Without that the cash would leave an asset account with no envelope falling
  // to match it, and the identity in `core/budget.ts` would not hold.
  const paymentCategory = isDebt(to) ? paymentCategoryFor(state, to.id) : null;
  // Paying *from* a card is a cash advance: it draws on the card's own credit,
  // so nothing is categorised — the debt simply grows.
  const label = payee || `${paymentCategory ? 'Payment' : 'Transfer'} to ${to?.name ?? 'account'}`;

  const outflow = makeTransaction({
    date: when,
    accountId: fromAccountId,
    categoryId: paymentCategory?.id ?? null,
    payee: label,
    memo: memo || '',
    amount: -cents,
    kind: 'transfer',
    cleared: cleared ?? false,
    transferId,
  });
  const inflow = makeTransaction({
    date: when,
    accountId: toAccountId,
    categoryId: null,
    payee: payee || `Transfer from ${from?.name ?? 'account'}`,
    memo: memo || '',
    amount: cents,
    kind: 'transfer',
    cleared: cleared ?? false,
    transferId,
  });

  const legs: Transaction[] = [outflow, inflow];

  // The fee shares the transferId so deleting the transfer takes it along, but
  // it is an expense rather than a transfer leg — see `updateTransaction`, which
  // mirrors amounts across legs and must not touch this row.
  const feeAmount = Math.abs(Math.round(fee ?? 0));
  if (feeAmount && feeCategoryId) {
    legs.push(
      makeTransaction({
        date: when,
        accountId: fromAccountId,
        categoryId: feeCategoryId,
        payee: `${to?.name ?? 'Transfer'} — fee`,
        memo: memo || '',
        amount: -feeAmount,
        kind: 'expense',
        cleared: cleared ?? false,
        transferId,
      }),
    );
  }

  return { ...state, transactions: [...state.transactions, ...legs] };
}

/** Convenience wrapper used by the card views. */
export function payCard(state: AppState, { cardId, fromAccountId, amount, date, memo }: PaymentInput): AppState {
  return addTransfer(state, {
    fromAccountId,
    toAccountId: cardId,
    amount,
    date,
    memo,
    payee: `Payment to ${state.accounts.find((a) => a.id === cardId)?.name ?? 'card'}`,
  });
}

/* ── Import / export ──────────────────────────────────────────────────── */

export function toBackup(state: AppState): string {
  return JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
}

export function fromBackup(json: string | unknown): AppState {
  const parsed: unknown = typeof json === 'string' ? JSON.parse(json) : json;
  if (!parsed || typeof parsed !== 'object') throw new Error('That file is not a Zenith backup.');
  const candidate = parsed as Record<string, unknown>;
  for (const key of ['accounts', 'categories', 'transactions'] as const) {
    if (!Array.isArray(candidate[key])) throw new Error(`Backup is missing "${key}".`);
  }
  if (!candidate.budgets || typeof candidate.budgets !== 'object') candidate.budgets = {};
  if (!Array.isArray(candidate.sharedLimits)) candidate.sharedLimits = [];
  if (!Array.isArray(candidate.installments)) candidate.installments = [];
  delete candidate.exportedAt;
  return tidySharedLimits(ensurePaymentCategories(candidate as unknown as AppState));
}

/** Transactions as CSV, newest first. */
export function toCsv(state: AppState): string {
  const accounts = new Map(state.accounts.map((a) => [a.id, a.name]));
  const categories = new Map(state.categories.map((c) => [c.id, c.name]));
  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows: string[][] = [['Date', 'Account', 'Payee', 'Category', 'Memo', 'Amount', 'Kind', 'Cleared']];
  const sorted = [...state.transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const tx of sorted) {
    rows.push([
      tx.date,
      (tx.accountId && accounts.get(tx.accountId)) || '',
      tx.payee,
      (tx.categoryId && categories.get(tx.categoryId)) || '',
      tx.memo,
      (tx.amount / 100).toFixed(2),
      tx.kind,
      tx.cleared ? 'yes' : 'no',
    ].map(escape));
  }
  return rows.map((row) => row.join(',')).join('\n');
}
