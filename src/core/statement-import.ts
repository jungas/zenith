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
import { cardBalance } from './cards.ts';
import { isCredit } from './model.ts';
import type { Account, AppState, Cents, ISODate, Transaction } from './model.ts';
import type { StatementRow } from './statement.ts';

/**
 * What a row will become in the ledger.
 *
 * `transfer` is the one a person has to choose: nothing on a statement says
 * whether "TRANSFER TO SAVINGS" left your money or went to your own other
 * account. Recorded as spending it would overstate what you spent and, having
 * no envelope, come out of Ready to assign — see `core/budget.ts`. Recorded as
 * a transfer it is correctly uncategorised and changes nothing but where the
 * money sits.
 */
export type RowRole = 'charge' | 'refund' | 'payment' | 'expense' | 'income' | 'transfer';

export interface ImportDraft {
  rowId: string;
  date: ISODate;
  /**
   * The date the statement itself gives this row: its posting date when the
   * statement prints both, otherwise the single date it prints. Written into the
   * transaction, which is what makes importing the same statement twice a
   * recognised no-op rather than a second copy of every row.
   */
  postedDate: ISODate | null;
  payee: string;
  memo: string;
  /** Signed cents from the account's point of view. */
  amount: Cents;
  categoryId: string | null;
  role: RowRole;
  /**
   * The account on the other side. A card payment's source, or a transfer's
   * counterpart — the account the money went to, or came from.
   */
  fromAccountId: string | null;
  /** The id of an existing transaction this looks like, if any. */
  duplicateOf: string | null;
  /**
   * How that match was made. `posted` is the bank's own posting date agreeing
   * exactly, which is certainty; `near` is the older heuristic of the same
   * amount within a few days, which is a likeness. The review screen says which,
   * because the two deserve different amounts of trust.
   */
  duplicateBy: 'posted' | 'near' | null;
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

/**
 * Will this row actually reach the ledger?
 *
 * A transfer or a card payment needs the account on the other side; without it
 * the row is skipped rather than approximated, so it must not count towards any
 * total either.
 */
export function willBeWritten(draft: ImportDraft): boolean {
  if (!draft.include) return false;
  if (draft.role === 'payment' || draft.role === 'transfer') return Boolean(draft.fromAccountId);
  return true;
}

/** How many days apart two transactions may be and still be the same one. */
const DUPLICATE_WINDOW_DAYS = 4;

/**
 * The same window, widened for a transaction that settles a bill.
 *
 * A bill is commonly paid well ahead of, or after, the date it is entered
 * against — an autopay scheduled days before the due date, a person recording
 * the payment on the day they set it up rather than the day it clears. Four
 * days is too tight for that gap; the `billId` on the transaction is itself
 * strong evidence the row and the payment are the same thing, so a wider
 * window here does not trade away much certainty.
 */
const BILL_DUPLICATE_WINDOW_DAYS = 10;

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

/** What an existing transaction was matched on, and how strongly. */
export interface DuplicateMatch {
  transaction: Transaction;
  by: 'posted' | 'near';
}

/**
 * Find an existing transaction that is probably this same row.
 *
 * Two matches, in order of how much they are worth:
 *
 *  1. **The bank's own posting date, exactly.** Same account, same amount, same
 *     posted date — the statement said this row was posted on that day, and a
 *     statement does not change its mind. This is what makes re-importing a
 *     statement a no-op: the second pass recognises every row it wrote the first
 *     time, however far the transaction's own `date` has since been edited, and
 *     whether or not it still sits inside any window.
 *  2. **Same amount, within a few days.** The older heuristic, and still the only
 *     one available against a transaction typed in by hand or a statement that
 *     prints one date and calls it neither: a posting date rarely matches the
 *     date a person remembers.
 *
 * `used` stops one existing transaction from absorbing two identical statement
 * rows, because two coffees on the same day at the same price is a real thing
 * that happens.
 */
export function findDuplicate(
  state: AppState,
  accountId: string,
  draft: { date: ISODate; postedDate?: ISODate | null; amount: Cents },
  used: Set<string>,
  { exactOnly = false }: { exactOnly?: boolean } = {},
): DuplicateMatch | null {
  let best: Transaction | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const tx of state.transactions) {
    if (tx.accountId !== accountId || used.has(tx.id)) continue;
    if (tx.amount !== draft.amount) continue;

    if (draft.postedDate && tx.postedDate && tx.postedDate === draft.postedDate) {
      return { transaction: tx, by: 'posted' };
    }
    if (exactOnly) continue;

    // Either date may be the one that drifted, so the nearest pairing decides.
    // A row imported by its posting date and then re-read off a statement that
    // leads with the transaction date is one movement, not two.
    const distance = Math.min(
      daysApart(tx.date, draft.date),
      tx.postedDate ? daysApart(tx.postedDate, draft.date) : Number.POSITIVE_INFINITY,
      draft.postedDate ? daysApart(tx.date, draft.postedDate) : Number.POSITIVE_INFINITY,
      tx.postedDate && draft.postedDate
        ? daysApart(tx.postedDate, draft.postedDate)
        : Number.POSITIVE_INFINITY,
      // A bill's due date is a third anchor besides the transaction's own two
      // dates — the one a payment recorded ahead of time is likely closest to.
      tx.billId && tx.billDue ? daysApart(tx.billDue, draft.date) : Number.POSITIVE_INFINITY,
      tx.billId && tx.billDue && draft.postedDate
        ? daysApart(tx.billDue, draft.postedDate)
        : Number.POSITIVE_INFINITY,
    );
    const window = tx.billId ? BILL_DUPLICATE_WINDOW_DAYS : DUPLICATE_WINDOW_DAYS;
    if (distance > window) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = tx;
    }
  }
  return best ? { transaction: best, by: 'near' } : null;
}

/**
 * Match every row against the ledger, certainties first.
 *
 * Two passes rather than one, because the passes disagree about which row owns a
 * transaction. A row whose posting date matches exactly *is* that transaction;
 * letting an earlier row take it on a mere likeness would leave the certain
 * match looking new, and import a row the ledger already holds.
 */
function matchDuplicates(
  state: AppState,
  accountId: string,
  rows: Array<{ id: string; date: ISODate; postedDate: ISODate | null; amount: Cents }>,
): Map<string, DuplicateMatch> {
  const matches = new Map<string, DuplicateMatch>();
  const used = new Set<string>();

  for (const options of [{ exactOnly: true }, { exactOnly: false }]) {
    for (const row of rows) {
      if (matches.has(row.id)) continue;
      const match = findDuplicate(state, accountId, row, used, options);
      if (!match) continue;
      matches.set(row.id, match);
      used.add(match.transaction.id);
    }
  }
  return matches;
}

/* ── Money moved between your own accounts ────────────────────────────── */

/**
 * Wording that means the money moved rather than being spent.
 *
 * Never enough on its own. `PAYMENT TO MERALCO` is spending and `TRANSFER TO
 * 09171234567` went to somebody else; what makes a row an internal move is that
 * it *names an account you hold*, which is the second half of the test below.
 */
const MOVE_WORDS =
  /\b(transfer|xfer|top\s*-?\s*up|topup|cash\s*-?\s*in|remittance|payment\s+to|auto\s*debit|sweep|deposit\s+to|moved?\s+to|sen[dt]\s+to|load\s+to|funding)\b/i;

/**
 * Words that name a *kind* of account rather than one of yours, so they cannot
 * identify one on their own. Without this, every card statement row mentioning
 * "card" would look like a move to whichever account has the word in its name.
 */
const GENERIC_ACCOUNT_WORDS = new Set([
  'account', 'accounts', 'savings', 'saving', 'checking', 'chequing', 'cheque', 'current',
  'wallet', 'card', 'credit', 'debit', 'visa', 'mastercard', 'master', 'gold', 'platinum',
  'classic', 'signature', 'infinite', 'bank', 'cash', 'main', 'joint', 'personal', 'digital',
  'online', 'fund', 'funds', 'money', 'payment', 'payments', 'everyday', 'my', 'the',
]);

/** The strings that would identify this account in a statement's description. */
function accountKeys(account: Account): string[] {
  const keys = new Set<string>();
  const name = normalisePayee(account.name);
  // The whole name counts even when it is a generic word: someone whose account
  // is called "Savings" reads `TRANSFER TO SAVINGS` as naming it, and is right.
  if (name.length >= 3) keys.add(name);
  const provider = normalisePayee(account.provider ?? '');
  if (provider.length >= 3) keys.add(provider);
  for (const token of name.split(' ')) {
    if (token.length >= 3 && !GENERIC_ACCOUNT_WORDS.has(token)) keys.add(token);
  }
  return [...keys];
}

/**
 * Which of your own accounts this row names, if any.
 *
 * Moving money between your own accounts is not spending — nothing left, so no
 * envelope changes and no category is wanted (see `core/budget.ts`). Nothing on
 * a statement announces that, so the two things asked for here are the two a
 * statement can actually show: wording that means a movement, and the name or
 * bank of an account you hold. Both, or the row stays what it looked like.
 *
 * It remains a proposal either way: the review screen shows the account it
 * picked and the row can be switched straight back to spending.
 */
export function matchOwnAccount(
  state: AppState,
  description: string,
  accountId: string,
): Account | null {
  if (!MOVE_WORDS.test(description)) return null;
  const haystack = ` ${normalisePayee(description)} `;
  if (haystack.trim().length < 3) return null;

  let best: Account | null = null;
  let bestKey = 0;
  for (const account of state.accounts) {
    if (account.id === accountId || account.archived) continue;
    for (const key of accountKeys(account)) {
      // The longest key wins, so "BPI Savings" beats a second account that only
      // matched on the bank it shares with it.
      if (haystack.includes(` ${key} `) && key.length > bestKey) {
        best = account;
        bestKey = key.length;
      }
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

  // The date the statement gave this row — its posting date when the statement
  // prints both, otherwise the single date it prints. Kept even when it equals
  // `date`, because it is the bank's own record of the row and is what a second
  // import of the same statement is matched against.
  const dated = rows.map((row) => ({
    id: row.id,
    date: row.date,
    postedDate: row.postedDate ?? row.date,
    amount: signedAmount(row),
  }));
  const duplicates = matchDuplicates(state, accountId, dated);

  return rows.map((row, index) => {
    const amount = signedAmount(row);
    const posted = dated[index]?.postedDate ?? row.date;
    const duplicate = duplicates.get(row.id) ?? null;

    let role = roleFor(row, account);
    let fromAccountId = role === 'payment' ? paymentSourceId : null;

    // A row that names one of your own accounts moved money rather than spending
    // it. On a card statement a credit that already reads as a payment keeps
    // that role and only learns where the money came from, which the statement
    // has just told us better than any default could.
    const own = matchOwnAccount(state, row.description, accountId);
    if (own && role === 'payment' && !isCredit(own)) {
      fromAccountId = own.id;
    } else if (own && role !== 'payment') {
      role = 'transfer';
      fromAccountId = own.id;
    }

    return {
      rowId: row.id,
      date: row.date,
      postedDate: posted,
      payee: row.description,
      memo,
      amount,
      // Income has no category in this app; a payment to a card is categorised
      // by `addTransfer` itself — to the card's payment envelope; and money
      // moved between your own accounts is not spending, so it gets none.
      categoryId:
        role === 'income' || role === 'payment' || role === 'transfer'
          ? null
          : guessCategoryId(state, row.description),
      role,
      fromAccountId,
      duplicateOf: duplicate?.transaction.id ?? null,
      duplicateBy: duplicate?.by ?? null,
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
  /** Transfers and card payments with no other account chosen: not importable. */
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
    if (!willBeWritten(draft)) {
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

    if (draft.role === 'payment' || draft.role === 'transfer') {
      // Without the other account there is no honest way to record this: the
      // money came from, or went to, somewhere, and guessing where would
      // unbalance that account. Such rows are skipped rather than approximated.
      if (!draft.fromAccountId) continue;
      // Direction follows the sign. Money leaving this account moves out of it;
      // money arriving came from the other one. A card payment is always the
      // latter, which is why it reads the same way round.
      const outgoing = draft.amount < 0;
      next = addTransfer(next, {
        fromAccountId: outgoing ? accountId : draft.fromAccountId,
        toAccountId: outgoing ? draft.fromAccountId : accountId,
        amount: Math.abs(draft.amount),
        date: draft.date,
        // Both legs carry it: the movement was posted once, so importing the
        // other account's statement later recognises the leg already written.
        postedDate: draft.postedDate,
        payee: draft.payee,
        memo: draft.memo,
        cleared: true,
      });
      continue;
    }

    next = addTransaction(next, {
      date: draft.date,
      postedDate: draft.postedDate,
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

/* ── Checking the result against the statement ────────────────────────── */

export interface StatementReconciliation {
  /** What this card will show as of the statement date, if these rows import. */
  projected: Cents;
  /** What the statement says is owed. */
  stated: Cents;
  difference: Cents;
  agrees: boolean;
  /** The starting balance that would make the two agree. */
  suggestedOpeningBalance: Cents;
  /** True when the gap is exactly the net movement of the rows being imported. */
  looksLikeDoubleCount: boolean;
}

/**
 * Compare what the import will produce against what the statement says.
 *
 * This exists because of one very easy mistake. Adding a card asks for the
 * balance owed *today* — and if you take that figure off the statement you are
 * about to import, it already contains every transaction on it. Importing then
 * counts the same spending twice, and the card ends up wrong by exactly the net
 * movement of the statement.
 *
 * Nothing is corrected automatically: the check reports the gap, names the
 * likely cause, and offers the starting balance that would close it. Silently
 * rewriting an opening balance would be changing a number the person entered
 * on purpose.
 */
export function reconcileWithStatement(
  state: AppState,
  drafts: ImportDraft[],
  accountId: string,
  summary: { totalDue: Cents | null; statementDate: ISODate | null },
): StatementReconciliation | null {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!isCredit(account) || summary.totalDue == null) return null;

  const imported = applyImport(state, drafts, accountId);
  const projected = cardBalance(imported, accountId, summary.statementDate);
  const difference = summary.totalDue - projected;

  // Moving the opening balance by δ moves the card's balance by −δ.
  const suggestedOpeningBalance = account.openingBalance - difference;

  // The signature of a double count: the gap equals what these rows move the
  // balance by, because the starting figure already included them.
  const net = drafts.reduce(
    (total, draft) => (willBeWritten(draft) ? total - draft.amount : total),
    0,
  );
  return {
    projected,
    stated: summary.totalDue,
    difference,
    agrees: Math.abs(difference) < 1,
    suggestedOpeningBalance,
    looksLikeDoubleCount: net !== 0 && Math.abs(difference + net) < 1,
  };
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
