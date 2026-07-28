/**
 * Turning reviewed statement rows into transactions.
 *
 * The hard part is not the arithmetic, it is *which shape* each row has to take
 * so the budget still adds up afterwards. `core/budget.ts` documents the
 * identity this app checks at runtime:
 *
 *     readyToAssign + Σ available === Σ cash in asset accounts
 *
 * Four row shapes keep it true, and getting any of them wrong would silently
 * invent or destroy money:
 *
 * | Row | Recorded as | Why |
 * |---|---|---|
 * | Charge on a card | negative expense, categorised | draws the envelope down and reserves the same cash for the bill |
 * | Refund on a card | **positive expense**, categorised | returns the money to the envelope *and* releases the reserve, because the debt fell too |
 * | Payment to a card | a **transfer** from an asset account | the cash genuinely moved; recording it on the card alone would create money from nowhere |
 * | Spending / income on an asset account | negative expense / positive income | the ordinary case |
 *
 * The one that most wants to be wrong is the card refund. Recording it as
 * `income` would add to Ready to assign without a peso arriving anywhere, and
 * the integrity check in Settings would start reporting a difference.
 */

import { addTransaction, addTransfer } from './actions.ts';
import { isCredit } from './model.ts';
import type { Account, AppState, Cents, ISODate, Transaction } from './model.ts';
import type { StatementRow } from './statement.ts';

/** What a row will become in the ledger. */
export type RowRole = 'charge' | 'refund' | 'payment' | 'expense' | 'income';

export interface ImportDraft {
  rowId: string;
  date: ISODate;
  payee: string;
  memo: string;
  /** Signed cents from the account's point of view. */
  amount: Cents;
  categoryId: string | null;
  role: RowRole;
  /** Payments to a card only: the asset account the money came from. */
  fromAccountId: string | null;
  /** The id of an existing transaction this looks like, if any. */
  duplicateOf: string | null;
  /** Unticked rows are not imported. Duplicates start unticked. */
  include: boolean;
}

export interface DraftOptions {
  accountId: string;
  /** Written into every imported transaction's memo. */
  memo?: string;
  /** Default source account offered for card payments. */
  paymentSourceId?: string | null;
}

/** How many days apart two transactions may be and still be the same one. */
const DUPLICATE_WINDOW_DAYS = 4;

/** A card credit whose wording means "you paid this bill", not "you were refunded". */
const CARD_PAYMENT_WORDS = /^payment\b|\bpayment\s+received\b|\bthank\s*you\b|^auto\s*debit\b/i;

/* ── Payee matching ───────────────────────────────────────────────────── */

/**
 * Reduce a payee to something comparable.
 *
 * Statements decorate the same merchant differently every month — branch codes,
 * terminal ids, city names, a `*` prefix from a payment processor — so matching
 * on the raw string finds almost nothing.
 */
export function normalisePayee(payee: string): string {
  return payee
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The leading words of a payee, which is the part that names the merchant. */
function payeeKey(payee: string): string {
  return normalisePayee(payee).split(' ').slice(0, 3).join(' ');
}

/**
 * Which category this payee went to last time.
 *
 * Learned from the user's own ledger rather than a built-in merchant list: a
 * shipped list would be wrong for anyone whose spending does not look like the
 * author's, and this is right for everyone by construction.
 */
export function guessCategoryId(state: AppState, payee: string): string | null {
  const key = payeeKey(payee);
  if (key.length < 3) return null;

  const spending = new Set(
    state.categories.filter((c) => c.kind === 'spending' && !c.archived).map((c) => c.id),
  );

  let best: Transaction | null = null;
  for (const tx of state.transactions) {
    if (!tx.categoryId || !spending.has(tx.categoryId)) continue;
    const candidate = payeeKey(tx.payee);
    if (!candidate) continue;
    if (candidate !== key && !candidate.startsWith(key) && !key.startsWith(candidate)) continue;
    // The most recent match wins: a merchant you have re-categorised should
    // stay re-categorised.
    if (!best || tx.date > best.date) best = tx;
  }
  return best?.categoryId ?? null;
}

/* ── Duplicates ───────────────────────────────────────────────────────── */

function daysApart(a: ISODate, b: ISODate): number {
  const parse = (iso: ISODate): number => {
    const [y = 0, m = 1, d = 1] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  };
  return Math.abs(Math.round((parse(a) - parse(b)) / 86_400_000));
}

/**
 * Find an existing transaction that is probably this same row.
 *
 * Same account, same amount to the peso, and within a few days — a statement's
 * posting date rarely matches the date you typed in. `used` stops one existing
 * transaction from absorbing two identical statement rows, because two coffees
 * on the same day at the same price is a real thing that happens.
 */
export function findDuplicate(
  state: AppState,
  accountId: string,
  draft: { date: ISODate; amount: Cents },
  used: Set<string>,
): Transaction | null {
  let best: Transaction | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const tx of state.transactions) {
    if (tx.accountId !== accountId || used.has(tx.id)) continue;
    if (tx.amount !== draft.amount) continue;
    const distance = daysApart(tx.date, draft.date);
    if (distance > DUPLICATE_WINDOW_DAYS) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = tx;
    }
  }
  return best;
}

/* ── Drafts ───────────────────────────────────────────────────────────── */

function roleFor(row: StatementRow, account: Account | undefined): RowRole {
  if (isCredit(account)) {
    if (row.direction === 'debit') return 'charge';
    return CARD_PAYMENT_WORDS.test(row.description) ? 'payment' : 'refund';
  }
  return row.direction === 'debit' ? 'expense' : 'income';
}

/** Signed cents from the account's point of view. Debits leave, credits arrive. */
function signedAmount(row: StatementRow): Cents {
  return row.direction === 'debit' ? -Math.abs(row.amount) : Math.abs(row.amount);
}

/**
 * Prepare every row for review. Nothing is written here — the result is what
 * the import screen renders, and every field on it stays editable.
 */
export function buildDrafts(
  state: AppState,
  rows: StatementRow[],
  { accountId, memo = '', paymentSourceId = null }: DraftOptions,
): ImportDraft[] {
  const account = state.accounts.find((a) => a.id === accountId);
  const used = new Set<string>();

  return rows.map((row) => {
    const role = roleFor(row, account);
    const amount = signedAmount(row);
    const duplicate = findDuplicate(state, accountId, { date: row.date, amount }, used);
    if (duplicate) used.add(duplicate.id);

    return {
      rowId: row.id,
      date: row.date,
      payee: row.description,
      memo,
      amount,
      // Income has no category in this app, and a payment to a card is
      // categorised by `addTransfer` itself — to the card's payment envelope.
      categoryId:
        role === 'income' || role === 'payment' ? null : guessCategoryId(state, row.description),
      role,
      fromAccountId: role === 'payment' ? paymentSourceId : null,
      duplicateOf: duplicate?.id ?? null,
      include: !duplicate,
    };
  });
}

export interface ImportTotals {
  selected: number;
  duplicates: number;
  /** Money arriving, positive. */
  inflow: Cents;
  /** Money leaving, positive. */
  outflow: Cents;
  /** Card payments with no source account chosen: these cannot be imported. */
  unassignedPayments: number;
}

export function importTotals(drafts: ImportDraft[]): ImportTotals {
  let selected = 0;
  let duplicates = 0;
  let inflow = 0;
  let outflow = 0;
  let unassignedPayments = 0;
  for (const draft of drafts) {
    if (draft.duplicateOf) duplicates++;
    if (!draft.include) continue;
    if (draft.role === 'payment' && !draft.fromAccountId) {
      unassignedPayments++;
      continue;
    }
    selected++;
    if (draft.amount >= 0) inflow += draft.amount;
    else outflow += -draft.amount;
  }
  return { selected, duplicates, inflow, outflow, unassignedPayments };
}

/**
 * Write the selected drafts into the ledger.
 *
 * Imported rows are marked `cleared`: they came off a statement, so the bank
 * has already settled them — which is exactly what that flag means.
 */
export function applyImport(
  state: AppState,
  drafts: ImportDraft[],
  accountId: string,
): AppState {
  let next = state;
  for (const draft of drafts) {
    if (!draft.include) continue;

    if (draft.role === 'payment') {
      // Without a source account there is no honest way to record this: the
      // money came from somewhere, and guessing where would unbalance that
      // account. Such rows are skipped rather than approximated.
      if (!draft.fromAccountId) continue;
      next = addTransfer(next, {
        fromAccountId: draft.fromAccountId,
        toAccountId: accountId,
        amount: Math.abs(draft.amount),
        date: draft.date,
        payee: draft.payee,
        memo: draft.memo,
        cleared: true,
      });
      continue;
    }

    next = addTransaction(next, {
      date: draft.date,
      accountId,
      // A refund is a positive *expense*: it belongs to the envelope it came
      // out of, and calling it income would add money the budget never received.
      kind: draft.role === 'income' ? 'income' : 'expense',
      categoryId: draft.role === 'income' ? null : draft.categoryId,
      payee: draft.payee,
      memo: draft.memo,
      amount: draft.amount,
      cleared: true,
    });
  }
  return next;
}

/**
 * Which account a statement most likely belongs to.
 *
 * The last four digits are the strongest signal when a statement prints them,
 * followed by the issuing bank's name — which Zenith already stores per account
 * as `provider`.
 */
export function suggestAccountId(
  state: AppState,
  { accountHint, issuer, kind }: { accountHint: string | null; issuer: string | null; kind: string },
): string | null {
  const open = state.accounts.filter((a) => !a.archived);
  if (!open.length) return null;

  const wantsCard = kind === 'card';
  const shortlist = open.filter((a) => isCredit(a) === wantsCard);
  const pool = shortlist.length ? shortlist : open;

  if (accountHint) {
    const byDigits = pool.find((a) => a.name.includes(accountHint) || a.note.includes(accountHint));
    if (byDigits) return byDigits.id;
  }
  if (issuer) {
    const byIssuer = pool.find(
      (a) => (a.provider ?? '').toLowerCase() === issuer.toLowerCase(),
    );
    if (byIssuer) return byIssuer.id;
    const byName = pool.find((a) => a.name.toLowerCase().includes(issuer.toLowerCase()));
    if (byName) return byName.id;
  }
  return pool[0]?.id ?? null;
}
