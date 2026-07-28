/**
 * Reading a statement: lines of text in, candidate transactions out.
 *
 * There is no standard for how a bank lays out a statement, so this is
 * unavoidably a set of heuristics. Two things keep them honest:
 *
 *  1. **Columns are read from coordinates, not from spacing.** The extractor
 *     hands over the x position of every run, so a "DEBIT" header at x=400
 *     identifies every amount that lands under it — which is the difference
 *     between money leaving and money arriving, and is invisible in the joined
 *     text of the line.
 *  2. **Nothing here decides anything.** Every row it produces is a *proposal*
 *     shown for review before it becomes a transaction, and every field on it
 *     can be corrected. A parser that guesses wrong costs a moment; a parser
 *     that silently writes to the ledger costs trust.
 */

import { toISO } from './dates.ts';
import type { Cents, ISODate } from './model.ts';
import type { TextItem, TextLine } from './pdf/text.ts';

/** Which way money moved, from the account holder's point of view. */
export type Direction = 'debit' | 'credit';

export interface StatementRow {
  /** Stable across re-parses of the same document, so review state survives. */
  id: string;
  date: ISODate;
  /** The posting date, when the statement gives both. */
  postedDate: ISODate | null;
  description: string;
  /** Always positive; `direction` carries the sign. */
  amount: Cents;
  direction: Direction;
  /** Why we think it goes that way — shown in the review table. */
  reason: 'column' | 'marker' | 'sign' | 'keyword' | 'default';
  page: number;
  raw: string;
}

export interface StatementSummary {
  /** The bank whose name is on the statement, matched to Zenith's issuer list. */
  issuer: string | null;
  /** Last four digits of the card or account number, when the statement shows them. */
  accountHint: string | null;
  currency: string | null;
  periodFrom: ISODate | null;
  periodTo: ISODate | null;
  statementDate: ISODate | null;
  dueDate: ISODate | null;
  totalDue: Cents | null;
  minimumDue: Cents | null;
  previousBalance: Cents | null;
  creditLimit: Cents | null;
}

export type StatementKind = 'card' | 'bank' | 'unknown';
export type DateOrder = 'dmy' | 'mdy';

export interface ParsedStatement {
  rows: StatementRow[];
  summary: StatementSummary;
  kind: StatementKind;
  /** How ambiguous numeric dates were read; the UI offers to flip it. */
  dateOrder: DateOrder;
  /** True when the document itself settled the order, so flipping is a mistake. */
  dateOrderCertain: boolean;
  /**
   * Whether the statement writes any date as bare numbers at all. A statement
   * that spells its months (`02 JUN 2026`) has nothing to flip, so offering the
   * choice would only invite someone to break it.
   */
  hasAmbiguousDates: boolean;
}

export interface ParseOptions {
  /** Used for ambiguous `03/04/2026` dates when the document does not decide. */
  dateOrder?: DateOrder;
  /** Today, for the "a statement cannot be from next year" check. */
  today?: Date;
}

/* ── Amounts ──────────────────────────────────────────────────────────── */

const CURRENCY_SYMBOLS: Record<string, string> = {
  '$': 'USD', '€': 'EUR', '£': 'GBP', '₱': 'PHP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW',
};
const CURRENCY_CODES = [
  'PHP', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'HKD', 'JPY', 'CNY', 'INR',
  'MYR', 'THB', 'IDR', 'KRW', 'NZD', 'CHF', 'AED', 'TWD', 'VND',
];

/** An amount as it appears in the text, with where it appeared. */
interface AmountToken {
  cents: Cents;
  start: number;
  end: number;
  text: string;
  /** `CR`/`DR` written beside the figure. */
  marker: 'CR' | 'DR' | null;
  negative: boolean;
  currency: string | null;
  /** True when the figure was written with a fractional part. */
  hasDecimals: boolean;
}

/**
 * Every optional part carries its own whitespace rather than sharing one loose
 * `\s*`, so that a match starts and ends on the figure itself. That matters
 * because the check below reads the characters on either side of a match: a
 * stray leading space would put the *previous* word's last letter there and
 * throw away a perfectly good amount.
 */
const AMOUNT_PATTERN = new RegExp(
  String.raw`(?:(${CURRENCY_CODES.join('|')})\s*|([$€£₱¥₹₩])\s*)?` + // currency
    String.raw`(?:(\()\s*)?(?:(-|\+)\s*)?` + //                          open paren / sign
    String.raw`(\d{1,3}(?:[,.\u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)` + // digits
    String.raw`(?:\s*(\)))?` + //                                        close paren
    String.raw`(?:\s*(CR|DR)\b)?`, //                                    credit/debit marker
  'gi',
);

/**
 * Turn a digit group into cents.
 *
 * The separator that matters is the *last* one: `1,234.56` and `1.234,56` are
 * the same amount written by different halves of the world, and both are
 * decided by what follows the final separator — three digits means thousands,
 * one or two means decimals.
 *
 * An ordinary space is deliberately *not* accepted as a thousands separator,
 * even though several countries write amounts that way. On a statement it turns
 * `MERCURY DRUG STORE 214    876.30` into a single amount of 214,876.30 — the
 * branch number swallowed into the figure beside it.
 */
function digitsToCents(raw: string): Cents | null {
  const cleaned = raw.replace(/[\s\u00a0\u202f]/g, '');
  const lastSeparator = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
  let whole = cleaned;
  let fraction = '';
  if (lastSeparator >= 0) {
    const tail = cleaned.slice(lastSeparator + 1);
    if (tail.length === 3) {
      whole = cleaned; // a thousands separator: no decimal part at all
    } else if (tail.length === 1 || tail.length === 2) {
      whole = cleaned.slice(0, lastSeparator);
      fraction = tail.padEnd(2, '0');
    } else {
      return null;
    }
  }
  const digits = whole.replace(/[^0-9]/g, '');
  if (!digits) return null;
  const value = Number(digits) * 100 + Number(fraction || '0');
  return Number.isSafeInteger(value) ? value : null;
}

function findAmounts(text: string): AmountToken[] {
  const out: AmountToken[] = [];
  AMOUNT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const [whole, code, symbol, open, sign, digits, close, marker] = match;
    const index = match.index ?? 0;
    // Reject a figure glued to other characters: a card number, an invoice
    // reference or a phone number is not an amount.
    const before = text[index - 1] ?? ' ';
    const after = text[index + whole.length] ?? ' ';
    if (/[0-9A-Za-z*#/-]/.test(before) || /[0-9A-Za-z*#/]/.test(after)) continue;
    const cents = digitsToCents(digits ?? '');
    if (cents === null) continue;
    out.push({
      cents,
      start: index,
      end: index + whole.length,
      text: whole.trim(),
      marker: marker ? (marker.toUpperCase() as 'CR' | 'DR') : null,
      negative: Boolean(sign === '-' || (open && close)),
      currency: code ? code.toUpperCase() : symbol ? CURRENCY_SYMBOLS[symbol] ?? null : null,
      hasDecimals: /[.,]\d{1,2}$/.test(digits ?? ''),
    });
  }
  return out;
}

/* ── Dates ────────────────────────────────────────────────────────────── */

const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

const MONTH_PATTERN = MONTHS.join('|');

interface DateMatch {
  start: number;
  end: number;
  year: number | null;
  month: number;
  day: number;
  /** True when only the document's convention can tell day from month. */
  ambiguous: boolean;
}

/** Every date-shaped run in a line, in the order they appear. */
function findDates(text: string): DateMatch[] {
  const out: DateMatch[] = [];
  const claim = (start: number, end: number): boolean =>
    !out.some((existing) => start < existing.end && end > existing.start);

  const push = (match: DateMatch): void => {
    if (claim(match.start, match.end)) out.push(match);
  };

  // 2026-06-18
  for (const m of text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    push({
      start: m.index ?? 0, end: (m.index ?? 0) + m[0].length,
      year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), ambiguous: false,
    });
  }
  // 18 Jun 2026 / 18-JUN-26 / 18 June
  for (const m of text.matchAll(
    new RegExp(String.raw`\b(\d{1,2})[\s\-./]*(${MONTH_PATTERN})[a-z]*\.?(?:[\s\-./,]+(\d{2,4}))?\b`, 'gi'),
  )) {
    push({
      start: m.index ?? 0, end: (m.index ?? 0) + m[0].length,
      year: m[3] ? normaliseYear(Number(m[3])) : null,
      month: MONTHS.indexOf((m[2] ?? '').slice(0, 3).toLowerCase()) + 1,
      day: Number(m[1]), ambiguous: false,
    });
  }
  // Jun 18, 2026 / June 18
  for (const m of text.matchAll(
    new RegExp(String.raw`\b(${MONTH_PATTERN})[a-z]*\.?[\s\-./]+(\d{1,2})(?:[\s\-./,]+(\d{2,4}))?\b`, 'gi'),
  )) {
    push({
      start: m.index ?? 0, end: (m.index ?? 0) + m[0].length,
      year: m[3] ? normaliseYear(Number(m[3])) : null,
      month: MONTHS.indexOf((m[1] ?? '').slice(0, 3).toLowerCase()) + 1,
      day: Number(m[2]), ambiguous: false,
    });
  }
  // 06/18/2026 or 18/06/2026 — only the document as a whole can say which.
  for (const m of text.matchAll(/\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\b/g)) {
    const first = Number(m[1]);
    const second = Number(m[2]);
    if (first < 1 || first > 31 || second < 1 || second > 31) continue;
    push({
      start: m.index ?? 0, end: (m.index ?? 0) + m[0].length,
      year: m[3] ? normaliseYear(Number(m[3])) : null,
      month: second, day: first, ambiguous: true,
    });
  }

  return out.sort((a, b) => a.start - b.start);
}

function normaliseYear(year: number): number {
  if (year >= 1000) return year;
  // A two-digit year on a statement is this century; nobody is importing 1998.
  return year + (year >= 70 ? 1900 : 2000);
}

/**
 * Decide whether `03/04` means 3 April or 4 March.
 *
 * A single date above the twelfth settles it for the whole document, which is
 * why this looks at every date rather than each one alone.
 */
function inferDateOrder(matches: DateMatch[], fallback: DateOrder): { order: DateOrder; certain: boolean } {
  let dmyEvidence = 0;
  let mdyEvidence = 0;
  for (const match of matches) {
    if (!match.ambiguous) continue;
    if (match.day > 12) dmyEvidence++;
    if (match.month > 12) mdyEvidence++;
  }
  if (dmyEvidence && !mdyEvidence) return { order: 'dmy', certain: true };
  if (mdyEvidence && !dmyEvidence) return { order: 'mdy', certain: true };
  return { order: fallback, certain: false };
}

function resolveDate(
  match: DateMatch,
  order: DateOrder,
  yearHint: number,
  today: Date,
): ISODate | null {
  let day = match.day;
  let month = match.month;
  if (match.ambiguous && order === 'mdy') {
    day = match.month;
    month = match.day;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  let year = match.year ?? yearHint;
  if (match.year === null) {
    // A December row on a January statement belongs to the year before.
    const candidate = new Date(year, month - 1, day);
    const reference = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (candidate.getTime() - reference.getTime() > 45 * 86_400_000) year -= 1;
  }
  const date = new Date(year, month - 1, day);
  if (date.getMonth() !== month - 1) return null; // 31 February and friends
  return toISO(year, month, day);
}

/* ── Column geometry ──────────────────────────────────────────────────── */

interface Column {
  label: string;
  x: number;
  endX: number;
}

/**
 * Column headings, most specific first.
 *
 * A heading is rarely a single bare word: Philippine card statements print
 * `PAYMENTS/CREDITS`, `PURCHASES/CHARGES`, `AMOUNT (PHP)` and `TRANSACTION
 * DATE`, so a heading is matched by *any* of its words and the earliest entry
 * in this list wins. Money columns therefore beat `date` and `description` when
 * a heading names both.
 */
const COLUMN_WORDS = [
  'withdrawals', 'withdrawal', 'deposits', 'deposit', 'payments', 'payment',
  'credits', 'credit', 'debits', 'debit', 'charges', 'purchases', 'amount',
  'balance', 'particulars', 'description', 'reference', 'date',
];

/** Column headings whose figures are transaction amounts. */
const MONEY_COLUMNS = new Set([
  'amount', 'debit', 'debits', 'credit', 'credits', 'deposit', 'deposits',
  'withdrawal', 'withdrawals', 'charges', 'payments', 'payment', 'purchases',
]);

/** The column word a heading names, or null if it names none. */
function headingLabel(text: string): string | null {
  const words = new Set(
    text.toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter(Boolean),
  );
  return COLUMN_WORDS.find((word) => words.has(word)) ?? null;
}

/**
 * Find the statement's column headings and remember where they sit.
 *
 * Amounts are right-aligned under their heading in every statement layout worth
 * the name, so a heading's right edge is what identifies the column an amount
 * belongs to.
 */
function findColumns(lines: TextLine[]): Column[] {
  let best: Column[] = [];
  for (const line of lines) {
    const words = line.items
      .map((item) => ({ item, label: headingLabel(item.text) }))
      .filter((entry): entry is { item: TextItem; label: string } => entry.label !== null);
    // A header names at least two columns; one word is a coincidence.
    if (words.length < 2 || words.length <= best.length) continue;
    // A header row carries no amounts of its own.
    if (findAmounts(line.text).length) continue;
    best = words.map(({ item, label }) => ({ label, x: item.x, endX: item.endX }));
  }
  return best;
}

/** Which column an amount landed in, by matching right edges. */
function columnFor(columns: Column[], item: TextItem | null): string | null {
  if (!item || !columns.length) return null;
  let match: Column | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const column of columns) {
    const distance = Math.abs(column.endX - item.endX);
    if (distance < bestDistance) {
      bestDistance = distance;
      match = column;
    }
  }
  // Right edges line up closely or not at all; a loose match is not a match.
  return match && bestDistance <= Math.max(12, item.size * 1.5) ? match.label : null;
}

/** The run that contains a character offset within the joined line text. */
function itemAt(line: TextLine, offset: number): TextItem | null {
  for (let i = line.items.length - 1; i >= 0; i--) {
    const start = line.offsets[i] ?? 0;
    const item = line.items[i];
    if (item && offset >= start && offset < start + item.text.length) return item;
  }
  return null;
}

/* ── Descriptions ─────────────────────────────────────────────────────── */

const NOISE_PATTERNS = [
  /\bref(?:erence)?(?:\s*(?:no|number|#))?[:.\s]*[a-z0-9-]{6,}\b/gi,
  /\btrace\s*(?:no|id)?[:.\s]*[0-9]{6,}\b/gi,
  /\b[0-9]{12,}\b/g,
];

/**
 * Short words that are English rather than acronyms. Without this list,
 * softening the shouting turns `THANK YOU` into `Thank YOU`, while lowering
 * every short word turns `ATM`, `SM` and `BPI` into `Atm`, `Sm` and `Bpi`.
 */
const SHORT_WORDS = new Set([
  'you', 'the', 'and', 'for', 'was', 'are', 'not', 'via', 'per', 'our', 'its',
  'fee', 'tax', 'air', 'gas', 'new', 'old', 'pay', 'car', 'day', 'way', 'top',
  'all', 'off', 'out', 'one', 'two', 'ten', 'inc', 'ltd', 'co', 'net',
]);

/**
 * Words to leave shouting. Four letters or more usually means a word rather
 * than an acronym — except for the ones that matter most here, which are the
 * banks and agencies whose names appear on Philippine statements. `RCBC` must
 * not become `Rcbc`.
 */
const KEEP_UPPERCASE = new Set([
  'RCBC', 'HSBC', 'BDO', 'BPI', 'PNB', 'AUB', 'DBP', 'LBP', 'SSS', 'BIR', 'PSE',
  'NAIA', 'NLEX', 'SLEX', 'EDSA', 'MRT', 'LRT', 'ATM', 'POS', 'DST', 'VAT',
  'TIN', 'PHP', 'USD', 'GCASH', 'PLDT', 'SMDC', 'MERALCO', 'BDOU', 'UBP',
  'ATMS', 'CTBC', 'BANCNET', 'MEGALINK', 'PESONET', 'INSTAPAY', 'SWIFT',
]);

/** Tidy a description without throwing away anything a person would recognise. */
export function cleanDescription(raw: string): string {
  let text = raw;
  for (const pattern of NOISE_PATTERNS) text = text.replace(pattern, ' ');
  text = text.replace(/\s+/g, ' ').replace(/[\s*·•\-—,;:]+$/, '').replace(/^[\s*·•\-—,;:]+/, '').trim();

  // Statements shout. Soften a run of capitals into title case, but leave short
  // all-capital words alone: they are far more often an acronym than a word.
  if (text === text.toUpperCase()) {
    text = text
      .split(' ')
      .map((word) =>
        word
          .split('-')
          .map((part) => {
            if (!/^[A-Z]+$/.test(part) || KEEP_UPPERCASE.has(part)) return part;
            const isWord = part.length >= 4 || SHORT_WORDS.has(part.toLowerCase());
            return isWord ? part[0] + part.slice(1).toLowerCase() : part;
          })
          .join('-'),
      )
      .join(' ');
  }
  return text;
}

/* ── Issuers ──────────────────────────────────────────────────────────── */

/**
 * Banks whose name on a statement we recognise.
 *
 * The names match `CARD_ISSUERS` and the wallet providers in `core/model.ts`,
 * so a recognised issuer can preselect the account the statement belongs to.
 * Philippine banks lead the list because they are the ones this app is used
 * with; the rest are here so a foreign card is not treated as unknown.
 *
 * Recognition only *identifies* the bank. It deliberately carries no per-bank
 * layout rules: a statement's own columns and dates describe it better than a
 * guess about what a bank's template looked like when this was written, and a
 * template that changes would then quietly produce wrong figures rather than
 * none.
 */
const ISSUER_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'BDO', pattern: /\bBDO\b|banco\s+de\s+oro/i },
  { name: 'BPI', pattern: /\bBPI\b|bank\s+of\s+the\s+philippine\s+islands/i },
  { name: 'UnionBank', pattern: /union\s?bank|\bUBP\b/i },
  { name: 'RCBC', pattern: /\bRCBC\b|rizal\s+commercial/i },
  { name: 'Metrobank', pattern: /metro\s?bank|metropolitan\s+bank/i },
  { name: 'Security Bank', pattern: /security\s+bank/i },
  { name: 'PNB', pattern: /\bPNB\b|philippine\s+national\s+bank/i },
  { name: 'EastWest Bank', pattern: /east\s?west/i },
  { name: 'China Bank', pattern: /china\s?bank(ing)?/i },
  { name: 'AUB', pattern: /\bAUB\b|asia\s+united\s+bank/i },
  { name: 'Landbank', pattern: /land\s?bank/i },
  { name: 'HSBC Philippines', pattern: /HSBC[^\n]{0,40}philippines/i },
  { name: 'Maya', pattern: /\bmaya\b|paymaya/i },
  { name: 'GCash', pattern: /\bgcash\b|g-?xchange/i },
  { name: 'HSBC', pattern: /\bHSBC\b/i },
  { name: 'Citi', pattern: /\bciti(bank)?\b/i },
  { name: 'American Express', pattern: /american\s+express|\bamex\b/i },
  { name: 'Standard Chartered', pattern: /standard\s+chartered/i },
  { name: 'Chase', pattern: /\bchase\b/i },
  { name: 'Capital One', pattern: /capital\s+one/i },
  { name: 'Discover', pattern: /\bdiscover\s+(card|bank|financial)/i },
];

/**
 * Which bank issued this statement.
 *
 * Only the first page's opening lines are considered: a bank's name is at the
 * top of its own statement, whereas further down it appears in the merchant
 * names of every transfer and bills payment you made.
 */
export function detectIssuer(lines: TextLine[]): string | null {
  const header = lines
    .filter((line) => line.page === (lines[0]?.page ?? 1))
    .slice(0, 10)
    .map((line) => line.text)
    .join('\n');

  // Whichever name appears *earliest* wins, rather than whichever pattern
  // happens to sit first in the list. An RCBC statement mentioning a transfer
  // from BPI is still an RCBC statement, and the masthead is what says so.
  let best: { name: string; at: number } | null = null;
  for (const { name, pattern } of ISSUER_PATTERNS) {
    const at = header.search(pattern);
    if (at < 0) continue;
    if (!best || at < best.at) best = { name, at };
  }
  return best?.name ?? null;
}

/* ── Summary ──────────────────────────────────────────────────────────── */

/**
 * The labels a statement prints beside its summary figures.
 *
 * Deliberately generous, and declared once so that the same pattern both
 * *excludes* a line from the transaction list and *reads* the figure off it —
 * two lists would drift, and a summary line this parser stopped recognising
 * would quietly reappear in the ledger as a transaction.
 *
 * The wording differs across BDO, BPI, UnionBank and RCBC ("Please Pay On Or
 * Before", "Total Amount Due", "Outstanding Balance"), so each covers several
 * phrasings.
 */
const STATEMENT_DATE_LABEL =
  /statement\s+date|billing\s+date|statement\s+of\s+account\s+as\s+of|as\s+of\s+date/i;
const DUE_DATE_LABEL =
  /(payment\s+)?due\s+date|(please\s+)?pay\s+(by|on\s+or\s+before)/i;
const TOTAL_DUE_LABEL =
  /total\s+amount\s+due|new\s+balance|closing\s+balance|total\s+balance\s+due|outstanding\s+balance|amount\s+due/i;
const MINIMUM_DUE_LABEL =
  /minimum\s+amount\s+due|minimum\s+(payment|due)|min(?:imum)?\.?\s+amount\s+due/i;
const PREVIOUS_BALANCE_LABEL =
  /previous\s+balance|opening\s+balance|balance\s+forward|beginning\s+balance|balance\s+b\/f|prev\.?\s+balance/i;
const CREDIT_LIMIT_LABEL = /credit\s+limit|approved\s+limit/i;
const ACCOUNT_NUMBER_LABEL = /(card|account)\s*(number|no\.?|#)/i;
const PERIOD_LABEL =
  /statement\s+period|billing\s+period|period\s+covered|for\s+the\s+period|statement\s+cycle|cut-?off/i;

const SUMMARY_LABELS = [
  STATEMENT_DATE_LABEL, DUE_DATE_LABEL, TOTAL_DUE_LABEL, MINIMUM_DUE_LABEL,
  PREVIOUS_BALANCE_LABEL, CREDIT_LIMIT_LABEL, ACCOUNT_NUMBER_LABEL, PERIOD_LABEL,
];

/** Is this line a heading, total or footer rather than a transaction? */
function isSummaryLine(text: string): boolean {
  return SUMMARY_LABELS.some((pattern) => pattern.test(text)) ||
    /^(sub-?total|total|balance|carried forward|brought forward|page \d)/i.test(text.trim()) ||
    /\bpage \d+\s*(of|\/)\s*\d+/i.test(text);
}

function readSummary(
  lines: TextLine[],
  order: DateOrder,
  yearHint: number,
  today: Date,
): StatementSummary {
  const summary: StatementSummary = {
    issuer: detectIssuer(lines), accountHint: null, currency: null,
    periodFrom: null, periodTo: null, statementDate: null, dueDate: null,
    totalDue: null, minimumDue: null, previousBalance: null, creditLimit: null,
  };

  const dateOn = (text: string, skip = 0): ISODate | null => {
    const matches = findDates(text);
    const match = matches[skip];
    return match ? resolveDate(match, order, yearHint, today) : null;
  };
  const amountOn = (text: string): Cents | null => {
    // The label may itself contain digits ("Minimum Amount Due (2%)"), so take
    // the last figure on the line — the value always trails the label.
    const amounts = findAmounts(text);
    return amounts.length ? amounts[amounts.length - 1]?.cents ?? null : null;
  };

  for (const line of lines) {
    const text = line.text;
    if (summary.dueDate === null && DUE_DATE_LABEL.test(text)) {
      summary.dueDate = dateOn(text);
    }
    if (summary.statementDate === null && STATEMENT_DATE_LABEL.test(text)) {
      summary.statementDate = dateOn(text);
    }
    if (summary.totalDue === null && TOTAL_DUE_LABEL.test(text)) {
      summary.totalDue = amountOn(text);
    }
    if (summary.minimumDue === null && MINIMUM_DUE_LABEL.test(text)) {
      summary.minimumDue = amountOn(text);
    }
    if (summary.previousBalance === null && PREVIOUS_BALANCE_LABEL.test(text)) {
      summary.previousBalance = amountOn(text);
    }
    if (summary.creditLimit === null && CREDIT_LIMIT_LABEL.test(text)) {
      summary.creditLimit = amountOn(text);
    }
    if (summary.periodFrom === null && PERIOD_LABEL.test(text)) {
      const matches = findDates(text);
      if (matches.length >= 2) {
        summary.periodFrom = resolveDate(matches[0] as DateMatch, order, yearHint, today);
        summary.periodTo = resolveDate(matches[1] as DateMatch, order, yearHint, today);
      }
    }
    if (summary.accountHint === null && ACCOUNT_NUMBER_LABEL.test(text)) {
      // Masked numbers keep their last group in the clear: `**** 4821`.
      const digits = [...text.matchAll(/(\d{4})(?!\d)/g)].map((m) => m[1]);
      const last = digits[digits.length - 1];
      if (last) summary.accountHint = last;
    }
    if (summary.currency === null) {
      for (const amount of findAmounts(text)) {
        if (amount.currency) {
          summary.currency = amount.currency;
          break;
        }
      }
    }
  }

  return summary;
}

function detectKind(lines: TextLine[]): StatementKind {
  const text = lines.slice(0, 40).map((line) => line.text).join(' \n ').toLowerCase();
  const cardSignals = [
    /credit\s+card/, /minimum\s+(amount\s+)?due/, /credit\s+limit/, /available\s+credit/,
    /finance\s+charge/, /cash\s+advance/, /statement\s+of\s+account/,
  ].filter((pattern) => pattern.test(text)).length;
  const bankSignals = [
    /savings\s+account/, /checking\s+account|current\s+account/, /withdrawal/, /deposit/,
    /running\s+balance/, /debit\s+credit/, /opening\s+balance/,
  ].filter((pattern) => pattern.test(text)).length;
  if (cardSignals > bankSignals) return 'card';
  if (bankSignals > cardSignals) return 'bank';
  return 'unknown';
}

/* ── Direction ────────────────────────────────────────────────────────── */

/**
 * Words that name the direction of a row when nothing else does.
 *
 * The Philippine terms are here for the same reason the labels above are:
 * `PAYMENT - THANK YOU` (BDO), `PAYMENT RECEIVED`, `REVERSAL`, `INSTAPAY` and
 * `PESONET` are what these statements actually print, and a row whose direction
 * is guessed wrong is a charge recorded as a refund.
 */
const CREDIT_WORDS =
  /^payment\b|\bpayment\s+received\b|\bthank\s*you\b|\b(refund|reversal|reversed|rebate|cashback|waived|credit\s+memo|interest\s+earned|salary|dividend|remittance|deposit)\b/i;
const DEBIT_WORDS =
  /\b(purchase|withdrawal|atm|pos|fee|charge|penalty|debit|bills?\s+payment|installment|instapay|pesonet|fund\s+transfer|transfer\s+to|annual\s+membership|late\s+payment|overlimit|over[\s-]?limit|finance\s+charge|documentary\s+stamp|\bdst\b|interest\s+charge)\b/i;

const CREDIT_COLUMNS = new Set(['credit', 'credits', 'deposit', 'deposits', 'payment', 'payments']);
const DEBIT_COLUMNS = new Set([
  'debit', 'debits', 'withdrawal', 'withdrawals', 'charges', 'purchases',
]);

function decideDirection(
  amount: AmountToken,
  column: string | null,
  description: string,
  kind: StatementKind,
): { direction: Direction; reason: StatementRow['reason'] } {
  // `PAYMENTS/CREDITS` and `PURCHASES/CHARGES` are the two column headings a
  // Philippine card statement uses, and they say the direction outright.
  if (CREDIT_COLUMNS.has(column ?? '')) return { direction: 'credit', reason: 'column' };
  if (DEBIT_COLUMNS.has(column ?? '')) return { direction: 'debit', reason: 'column' };
  if (amount.marker) return { direction: amount.marker === 'CR' ? 'credit' : 'debit', reason: 'marker' };
  if (amount.negative) {
    // On a card, a negative figure reduces what you owe — a refund. On a bank
    // account it is money leaving. Same sign, opposite meanings.
    return { direction: kind === 'bank' ? 'debit' : 'credit', reason: 'sign' };
  }
  // "PAYMENT - THANK YOU" is a credit even when nothing else says so.
  if (CREDIT_WORDS.test(description) && !DEBIT_WORDS.test(description)) {
    return { direction: 'credit', reason: 'keyword' };
  }
  if (DEBIT_WORDS.test(description)) return { direction: 'debit', reason: 'keyword' };
  return { direction: 'debit', reason: 'default' };
}

/* ── The parse ────────────────────────────────────────────────────────── */

/** How far into a line a transaction's date may start. */
const DATE_LEAD = 14;

export function parseStatement(lines: TextLine[], options: ParseOptions = {}): ParsedStatement {
  const today = options.today ?? new Date();
  const allDates = lines.flatMap((line) => findDates(line.text));
  const { order, certain } = inferDateOrder(allDates, options.dateOrder ?? 'dmy');

  const yearHint = guessYear(allDates, today);
  const summary = readSummary(lines, order, yearHint, today);
  const kind = detectKind(lines);
  const columns = findColumns(lines);

  // A statement's own dates are the best year hint there is.
  const anchorYear = summary.statementDate
    ? Number(summary.statementDate.slice(0, 4))
    : summary.periodTo
      ? Number(summary.periodTo.slice(0, 4))
      : yearHint;

  const rows: StatementRow[] = [];
  for (const [index, line] of lines.entries()) {
    const row = readRow(line, index, { order, anchorYear, today, columns, kind });
    if (row) rows.push(row);
  }

  return {
    rows,
    summary,
    kind,
    dateOrder: order,
    dateOrderCertain: certain,
    hasAmbiguousDates: allDates.some((match) => match.ambiguous),
  };
}

interface RowContext {
  order: DateOrder;
  anchorYear: number;
  today: Date;
  columns: Column[];
  kind: StatementKind;
}

function readRow(line: TextLine, index: number, context: RowContext): StatementRow | null {
  const text = line.text;
  if (!text || isSummaryLine(text)) return null;

  const dates = findDates(text).filter((match) => match.start <= DATE_LEAD);
  const first = dates[0];
  if (!first) return null;

  const date = resolveDate(first, context.order, context.anchorYear, context.today);
  if (!date) return null;

  // A second date immediately after the first is the posting date, not a value.
  const second = dates[1];
  const postedDate =
    second && second.start <= first.end + 4
      ? resolveDate(second, context.order, context.anchorYear, context.today)
      : null;

  const bodyStart = (postedDate ? second?.end : first.end) ?? first.end;
  const amounts = findAmounts(text).filter((amount) => amount.start >= bodyStart);
  if (!amounts.length) return null;

  const withColumns = amounts.map((amount) => ({
    amount,
    column: columnFor(context.columns, itemAt(line, amount.start)),
  }));

  // Drop anything under a running-balance column: that is the account's state
  // after the row, not the row itself.
  const notBalance = withColumns.filter(({ column }) => column !== 'balance');

  // Statements print money with cents. A bare integer inside a description is a
  // cheque number, a store code or a quantity — not an amount.
  const money = notBalance.filter(
    ({ amount }) => amount.hasDecimals || amount.currency || amount.marker,
  );
  const candidates = money.length ? money : notBalance;

  // A figure that landed under a money column is certain; without columns, the
  // position that carries the amount depends on the layout. A bank statement
  // puts the running balance last, so the first figure is the transaction; a
  // card statement puts a foreign-currency original first and the billed amount
  // last.
  const inMoneyColumn = candidates.filter(({ column }) => column && MONEY_COLUMNS.has(column));
  const pool = inMoneyColumn.length ? inMoneyColumn : candidates;
  const chosen = context.kind === 'bank' ? pool[0] : pool[pool.length - 1];
  if (!chosen || chosen.amount.cents <= 0) return null;

  const description = cleanDescription(text.slice(bodyStart, chosen.amount.start));
  if (!description) return null;

  const { direction, reason } = decideDirection(
    chosen.amount,
    chosen.column,
    description,
    context.kind,
  );

  return {
    id: `row-${line.page}-${index}`,
    date,
    postedDate,
    description,
    amount: chosen.amount.cents,
    direction,
    reason,
    page: line.page,
    raw: text,
  };
}

/** The year most of the document's dated rows agree on. */
function guessYear(matches: DateMatch[], today: Date): number {
  const counts = new Map<number, number>();
  for (const match of matches) {
    if (match.year === null) continue;
    counts.set(match.year, (counts.get(match.year) ?? 0) + 1);
  }
  let best = today.getFullYear();
  let bestCount = 0;
  for (const [year, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = year;
    }
  }
  return best;
}
