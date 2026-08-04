/**
 * State transitions. Every function takes state and returns *new* state —
 * nothing here mutates, so undo is just keeping the previous object.
 */

import {
  canJoinSharedLimit, ensurePaymentCategories, isCredit, isDebt, makeAccount, makeBill, makeCategory,
  makeInstallment, makeSharedLimit, makeTransaction, newId, paymentCategoryFor, sameBank,
  sharedLimitById,
} from './model.ts';
import type {
  Account, AccountDraft, AppState, Bill, Budgets, Category, Cents, Installment, ISODate, MonthKey,
  SharedLimit, Transaction,
} from './model.ts';
import { monthOf, todayISO } from './dates.ts';
import { billById, billFunding, forecastAmount, isSkipped } from './bills.ts';
import { readyToAssign } from './budget.ts';

/** Fields a caller may set when recording a transaction. */
export type TransactionDraft = Partial<Transaction>;

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amount: Cents;
  date?: ISODate;
  /**
   * When the bank posted it, when a statement says. Carried by both legs and by
   * the fee: one movement, one posting date, so re-importing either side's
   * statement recognises the leg it already wrote.
   */
  postedDate?: ISODate | null;
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

/**
 * Fields an existing transfer may be edited to. Everything is optional: what is
 * left out keeps whatever the transfer already says. A fee cannot be added or
 * removed here — it is spending, and adding some would be recording a
 * transaction, not editing this one.
 */
export interface TransferPatch {
  fromAccountId?: string;
  toAccountId?: string;
  amount?: Cents;
  date?: ISODate;
  postedDate?: ISODate | null;
  payee?: string;
  memo?: string;
  cleared?: boolean;
}

export interface PaymentInput {
  cardId: string;
  fromAccountId: string;
  amount: Cents;
  date?: ISODate;
  postedDate?: ISODate | null;
  memo?: string;
}

export interface LoanPaymentInput {
  loanId: string;
  fromAccountId: string;
  amount: Cents;
  date?: ISODate;
  postedDate?: ISODate | null;
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
    // A bill outlives the account it was paid from — the commitment is still
    // real — but it can no longer name one, so it asks again when next paid.
    bills: (state.bills ?? []).map((bill) =>
      bill.accountId === accountId ? { ...bill, accountId: null } : bill,
    ),
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

export interface ConvertToInstallmentInput {
  transactionId: string;
  /** How many monthly instalments the plan runs for. */
  months: number;
  description?: string;
  /** Defaults to the month the transaction fell in. */
  startMonth?: MonthKey;
  /** What is billed each month. Defaults to the price divided evenly across the term. */
  monthlyAmount?: Cents;
}

/**
 * Turn a purchase already sitting in the ledger into an instalment plan.
 *
 * A charge typed in — or read off a statement — before anyone told Zenith it
 * was on terms still holds the full price, because that is what was known at
 * the time. This does what a card issuer does on the next statement: the price
 * survives as the plan's `principal`, and the transaction itself is rewritten
 * down to what is actually billed each month, becoming the first instalment
 * rather than a second charge sitting beside the plan.
 *
 * Refused off a credit card, and for anything that is not an ordinary expense
 * — a plan bills a card, and there is no "instalment" on a transfer, income, or
 * the synthesised opening-balance row.
 */
export function convertTransactionToInstallment(
  state: AppState,
  input: ConvertToInstallmentInput,
): AppState {
  const transaction = state.transactions.find((t) => t.id === input.transactionId);
  if (!transaction || transaction.system || transaction.kind !== 'expense') return state;
  const card = state.accounts.find((a) => a.id === transaction.accountId);
  if (!isCredit(card)) return state;

  const principal = Math.abs(Math.round(transaction.amount));
  const months = Math.max(0, Math.round(input.months) || 0);
  if (!principal || months < 2) return state;
  const monthlyAmount = Math.max(0, Math.round(input.monthlyAmount ?? principal / months));
  if (!monthlyAmount) return state;

  const next = addInstallment(state, {
    accountId: card.id,
    description: input.description?.trim() || transaction.payee || 'Instalment plan',
    monthlyAmount,
    months,
    startMonth: input.startMonth || monthOf(transaction.date),
    principal,
  });
  // `addInstallment` refuses silently on bad input; nothing to point the
  // transaction at if that is what just happened.
  if (next.installments.length === state.installments.length) return state;

  return updateTransaction(next, transaction.id, { amount: -monthlyAmount });
}

/* ── Recurring bills ──────────────────────────────────────────────────── */

export interface BillPaymentInput {
  billId: string;
  /** Which occurrence is being settled, by its due date. */
  dueDate: ISODate;
  /** When the money actually left. Defaults to today, not to the due date. */
  date?: ISODate;
  /** What was paid. Defaults to the bill's expected amount. */
  amount?: Cents;
  /** Where it was paid from. Defaults to the bill's usual account. */
  accountId?: string;
  memo?: string;
  cleared?: boolean;
}

/**
 * Track a bill. A schedule needs an anchor date to step from, so a bill without
 * one would have no occurrences at all and is refused rather than stored empty.
 */
export function addBill(state: AppState, patch: Partial<Bill>): AppState {
  const bill = makeBill(patch);
  if (!bill.startDate) return state;
  return { ...state, bills: [...(state.bills ?? []), bill] };
}

export function updateBill(state: AppState, billId: string, patch: Partial<Bill>): AppState {
  return {
    ...state,
    bills: (state.bills ?? []).map((bill) =>
      bill.id === billId ? makeBill({ ...bill, ...patch, id: bill.id }) : bill,
    ),
  };
}

/**
 * Stop tracking a bill.
 *
 * The payments stay — they are real spending that really happened — but they
 * stop pointing at a bill that no longer exists, so nothing dangles and the
 * spending still sits in its category exactly as before.
 */
export function deleteBill(state: AppState, billId: string): AppState {
  return {
    ...state,
    bills: (state.bills ?? []).filter((bill) => bill.id !== billId),
    transactions: state.transactions.map((tx) =>
      tx.billId === billId ? { ...tx, billId: null, billDue: null } : tx,
    ),
  };
}

/**
 * Record a bill as paid.
 *
 * This is an ordinary expense with a receipt attached: the transaction carries
 * the bill's id and the due date it settles, and that tag is the *only* thing
 * that marks the occurrence paid. Paid on a credit card, it reserves cash in
 * that card's payment envelope like any other charge — the wiring in
 * `core/budget.ts` needs no special case for bills.
 */
export function payBill(state: AppState, input: BillPaymentInput): AppState {
  const bill = billById(state, input.billId);
  if (!bill || !input.dueDate) return state;

  const accountId = input.accountId || bill.accountId;
  if (!accountId || !state.accounts.some((account) => account.id === accountId)) return state;

  const amount = Math.abs(Math.round(input.amount ?? forecastAmount(state, bill)));
  if (!amount) return state;

  // Paying an occurrence that was marked skipped settles the argument: it was
  // not skipped after all.
  const next = isSkipped(bill, input.dueDate)
    ? unskipBillOccurrence(state, bill.id, input.dueDate)
    : state;

  return addTransaction(next, {
    date: input.date || todayISO(),
    accountId,
    categoryId: bill.categoryId,
    payee: bill.payee || bill.name,
    memo: input.memo ?? '',
    amount: -amount,
    kind: 'expense',
    cleared: input.cleared ?? false,
    billId: bill.id,
    billDue: input.dueDate,
  });
}

export interface LinkBillPaymentInput {
  billId: string;
  dueDate: ISODate;
  transactionId: string;
}

/**
 * Point an existing transaction at a bill occurrence, instead of recording a
 * second payment beside it.
 *
 * The money already moved — the transaction was typed in by hand before the
 * bill was tracked, or read off a statement that arrived before anyone told
 * Zenith about the bill. This writes the same receipt `payBill` would write
 * onto a new transaction, but onto the row that is actually it.
 */
export function linkBillPayment(state: AppState, input: LinkBillPaymentInput): AppState {
  const bill = billById(state, input.billId);
  if (!bill || !input.dueDate) return state;
  const transaction = state.transactions.find((t) => t.id === input.transactionId);
  if (!transaction) return state;

  // Paying an occurrence that was marked skipped settles the argument: it was
  // not skipped after all — the same rule `payBill` follows.
  const next = isSkipped(bill, input.dueDate)
    ? unskipBillOccurrence(state, bill.id, input.dueDate)
    : state;

  return updateTransaction(next, transaction.id, { billId: bill.id, billDue: input.dueDate });
}

/** Detach a transaction from the bill occurrence it settles. The money stays exactly where it is. */
export function unlinkBillPayment(state: AppState, transactionId: string): AppState {
  return updateTransaction(state, transactionId, { billId: null, billDue: null });
}

/** Mark one occurrence as deliberately not paid. */
export function skipBillOccurrence(state: AppState, billId: string, dueDate: ISODate): AppState {
  const bill = billById(state, billId);
  if (!bill || !dueDate || isSkipped(bill, dueDate)) return state;
  return updateBill(state, billId, { skipped: [...(bill.skipped ?? []), dueDate] });
}

export function unskipBillOccurrence(state: AppState, billId: string, dueDate: ISODate): AppState {
  const bill = billById(state, billId);
  if (!bill) return state;
  return updateBill(state, billId, {
    skipped: (bill.skipped ?? []).filter((date) => date !== dueDate),
  });
}

/**
 * Assign what this month's remaining bills need, soonest due first.
 *
 * Capped at what is actually unassigned: a budget that funds its bills by
 * going over-assigned has not funded anything, it has just moved the problem
 * into next month. When the money runs out the nearest due dates have it, and
 * the rest stay visibly short — which is the true state of things.
 */
export function assignForBills(state: AppState, month: MonthKey): AppState {
  let pool = readyToAssign(state, month);
  if (pool <= 0) return state;

  let next = state;
  for (const row of billFunding(state, { month }).rows) {
    if (pool <= 0) break;
    if (!row.categoryId || row.uncovered <= 0) continue;
    const top = Math.min(row.uncovered, pool);
    const current = next.budgets[month]?.[row.categoryId] ?? 0;
    next = setBudget(next, month, row.categoryId, current + top);
    pool -= top;
  }
  return next;
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
    // Bills budgeted here lose their envelope rather than pointing at a
    // category that is gone; they then read as unfunded, which is the truth.
    bills: (state.bills ?? []).map((bill) =>
      bill.categoryId === categoryId ? { ...bill, categoryId: null } : bill,
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
  //
  // The dates travel together — one movement was posted once, so a posted date
  // corrected on either leg belongs to both, and to the fee that rode along.
  const datePatch = {
    ...(patch.date ? { date: patch.date } : {}),
    ...('postedDate' in patch ? { postedDate: patch.postedDate || null } : {}),
  };
  const mirrors = patch.amount != null || Object.keys(datePatch).length > 0;
  if (existing.transferId && existing.kind === 'transfer' && mirrors) {
    const transactions = state.transactions.map((t) => {
      if (t.id === transactionId) return { ...t, ...patch };
      if (t.transferId !== existing.transferId) return t;
      if (t.kind !== 'transfer') return { ...t, ...datePatch };
      return {
        ...t,
        ...datePatch,
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
    fromAccountId, toAccountId, amount, date, postedDate, payee, memo, cleared, fee, feeCategoryId,
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
    postedDate: postedDate ?? null,
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
    postedDate: postedDate ?? null,
    accountId: toAccountId,
    // Money moved between your own accounts is not spending: nothing left, so
    // no envelope changes and neither leg carries a category. The one exception
    // is above — paying a debt spends the envelope that debt filled.
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
        postedDate: postedDate ?? null,
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

/** The two legs of a transfer, plus anything else riding on the same id. */
export function transferParts(
  state: AppState,
  transferId: string,
): { outflow: Transaction | null; inflow: Transaction | null; extras: Transaction[] } {
  let outflow: Transaction | null = null;
  let inflow: Transaction | null = null;
  const extras: Transaction[] = [];
  for (const tx of state.transactions) {
    if (tx.transferId !== transferId) continue;
    // A fee shares the id but is an expense in its own right, not a leg.
    if (tx.kind !== 'transfer') extras.push(tx);
    else if (tx.amount < 0) outflow ??= tx;
    else inflow ??= tx;
  }
  return { outflow, inflow, extras };
}

/**
 * Edit an existing transfer, both legs at once.
 *
 * A transfer is a linked pair, so it cannot be edited the way a single
 * transaction can: patching one leg would leave the other claiming a different
 * amount, a different date or a different account, and every total in the app is
 * computed from both. `updateTransaction` mirrors the fields it can, but the
 * accounts and the category are decided by *which way round* the transfer goes,
 * and only this knows that.
 *
 * The destination decides the category exactly as it does in `addTransfer`: pay a
 * debt and the outflow leg spends that debt's payment envelope, so redirecting a
 * transfer at a card earns the envelope, and redirecting it away from one gives
 * it up. Anything else moves money between your own accounts, which is not
 * spending and carries no category at all.
 *
 * The legs keep their ids, so undo, the ledger and anything holding a reference
 * still point at the same rows.
 */
export function updateTransfer(state: AppState, transferId: string, patch: TransferPatch): AppState {
  const { outflow, inflow } = transferParts(state, transferId);
  if (!outflow || !inflow) return state;

  const fromAccountId = patch.fromAccountId || outflow.accountId;
  const toAccountId = patch.toAccountId || inflow.accountId;
  // The same refusals as creating one: a transfer needs two different accounts
  // and an amount, or it is not a movement of money.
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) return state;
  const cents = Math.abs(Math.round(patch.amount ?? outflow.amount));
  if (!cents) return state;

  const date = patch.date || outflow.date;
  const postedDate = 'postedDate' in patch ? patch.postedDate || null : outflow.postedDate ?? null;
  const cleared = patch.cleared ?? outflow.cleared;
  const memo = patch.memo ?? outflow.memo;

  const to: Account | undefined = state.accounts.find((a) => a.id === toAccountId);
  const from: Account | undefined = state.accounts.find((a) => a.id === fromAccountId);
  const paymentCategory = isDebt(to) ? paymentCategoryFor(state, to.id) : null;
  const payee = patch.payee?.trim();
  const label = payee || `${paymentCategory ? 'Payment' : 'Transfer'} to ${to?.name ?? 'account'}`;

  const transactions = state.transactions.map((tx) => {
    if (tx.transferId !== transferId) return tx;
    if (tx.id === outflow.id) {
      return {
        ...tx,
        accountId: fromAccountId,
        categoryId: paymentCategory?.id ?? null,
        amount: -cents,
        date,
        postedDate,
        payee: label,
        memo,
        cleared,
      };
    }
    if (tx.id === inflow.id) {
      return {
        ...tx,
        accountId: toAccountId,
        categoryId: null,
        amount: cents,
        date,
        postedDate,
        payee: payee || `Transfer from ${from?.name ?? 'account'}`,
        memo,
        cleared,
      };
    }
    // A fee is real spending in its own right: it keeps its amount and its
    // category, and only follows the things it cannot disagree with — when the
    // movement happened, and which account was charged for it.
    return { ...tx, accountId: fromAccountId, date, postedDate, cleared };
  });
  return { ...state, transactions };
}

/** Convenience wrapper used by the card views. */
export function payCard(
  state: AppState,
  { cardId, fromAccountId, amount, date, postedDate, memo }: PaymentInput,
): AppState {
  return addTransfer(state, {
    fromAccountId,
    toAccountId: cardId,
    amount,
    date,
    postedDate,
    memo,
    payee: `Payment to ${state.accounts.find((a) => a.id === cardId)?.name ?? 'card'}`,
  });
}

/** Convenience wrapper used by the loan views. */
export function payLoan(
  state: AppState,
  { loanId, fromAccountId, amount, date, postedDate, memo }: LoanPaymentInput,
): AppState {
  return addTransfer(state, {
    fromAccountId,
    toAccountId: loanId,
    amount,
    date,
    postedDate,
    memo,
    payee: `Payment to ${state.accounts.find((a) => a.id === loanId)?.name ?? 'loan'}`,
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
  if (!Array.isArray(candidate.bills)) candidate.bills = [];
  delete candidate.exportedAt;
  return tidySharedLimits(ensurePaymentCategories(candidate as unknown as AppState));
}

/** Transactions as CSV, newest first. */
export function toCsv(state: AppState): string {
  const accounts = new Map(state.accounts.map((a) => [a.id, a.name]));
  const categories = new Map(state.categories.map((c) => [c.id, c.name]));
  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows: string[][] = [
    ['Date', 'Posted', 'Account', 'Payee', 'Category', 'Memo', 'Amount', 'Kind', 'Cleared'],
  ];
  const sorted = [...state.transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const tx of sorted) {
    rows.push([
      tx.date,
      tx.postedDate ?? '',
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
