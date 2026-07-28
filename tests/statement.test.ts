/**
 * Reading statements.
 *
 * The fixtures are four layouts modelled on the Philippine banks this app is
 * used with — BDO, BPI, UnionBank and RCBC — because the differences between
 * them are exactly what the parser has to survive: `MM/DD/YYYY` against
 * `DD MMM YY`, one amount column against split debit/credit columns, `CR`
 * markers against column position, and four different vocabularies for "total
 * amount due".
 *
 * Each is checked row by row rather than by count alone. A parser that finds
 * the right *number* of transactions and puts half of them on the wrong side of
 * the ledger is worse than one that finds none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readPdfText } from '../src/core/pdf/read.ts';
import { cleanDescription, detectIssuer, parseStatement } from '../src/core/statement.ts';
import type { ParsedStatement, StatementRow } from '../src/core/statement.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Parsed as of a fixed day, so the year-inference rules cannot drift. */
const TODAY = new Date(2026, 6, 1);

function parseFixture(file: string, password: string): ParsedStatement {
  const bytes = new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures', file)));
  return parseStatement(readPdfText(bytes, password).lines, { today: TODAY });
}

/** A compact view of a row, for readable assertions. */
const shape = (row: StatementRow): string =>
  `${row.date} ${row.direction} ${(row.amount / 100).toFixed(2)} ${row.description}`;

/* ── BDO: one amount column, CR markers, MM/DD/YYYY ───────────────────── */

test('BDO card statement', () => {
  const parsed = parseFixture('bdo-card-aes256.pdf', '7788');

  assert.equal(parsed.summary.issuer, 'BDO');
  assert.equal(parsed.kind, 'card');
  assert.equal(parsed.summary.accountHint, '7788');
  assert.equal(parsed.summary.statementDate, '2026-06-18');
  assert.equal(parsed.summary.dueDate, '2026-07-08');
  assert.equal(parsed.summary.totalDue, 2491820);
  assert.equal(parsed.summary.minimumDue, 124591);
  assert.equal(parsed.summary.previousBalance, 812045);
  assert.equal(parsed.summary.creditLimit, 20000000);

  // A day above the twelfth settles the day/month order for the whole document.
  assert.equal(parsed.dateOrder, 'mdy');
  assert.equal(parsed.dateOrderCertain, true);

  assert.deepEqual(parsed.rows.map(shape), [
    '2026-05-21 debit 2845.60 SM Supermarket Sucat',
    '2026-05-24 debit 310.00 Grab *TRIP',
    '2026-05-30 credit 8120.45 Payment - Thank You',
    '2026-06-02 debit 4512.33 MERALCO Online Payment',
    '2026-06-07 debit 1299.00 Shopee Philippines',
    '2026-06-10 debit 3500.00 Annual Membership Fee',
    '2026-06-12 credit 3500.00 Reversal - Annual Fee',
    '2026-06-15 debit 876.30 Mercury Drug 214',
  ]);
});

test('a merchant whose name ends in "payment" is still a charge', () => {
  // "MERALCO ONLINE PAYMENT" is a bill being paid *with* the card, not a
  // payment *to* the card. Reading it as a credit would cancel out a real
  // charge and quietly understate the balance.
  const parsed = parseFixture('bdo-card-aes256.pdf', '7788');
  const meralco = parsed.rows.find((row) => /MERALCO/i.test(row.description));
  assert.ok(meralco);
  assert.equal(meralco.direction, 'debit');
});

test('a description ending in digits does not merge with the amount beside it', () => {
  // `MERCURY DRUG 214` and `876.30` are two columns. Treating the space between
  // them as a thousands separator reads them as one amount of 214,876.30.
  const parsed = parseFixture('bdo-card-aes256.pdf', '7788');
  const row = parsed.rows.find((entry) => /Mercury/i.test(entry.description));
  assert.ok(row);
  assert.equal(row.amount, 87630);
  assert.equal(row.description, 'Mercury Drug 214');
});

/* ── BPI: split PURCHASES/CHARGES and PAYMENTS/CREDITS columns ─────────── */

test('BPI card statement reads direction from the column an amount sits in', () => {
  const parsed = parseFixture('bpi-card-rc4.pdf', '0620');

  assert.equal(parsed.summary.issuer, 'BPI');
  assert.equal(parsed.summary.accountHint, '3092');
  assert.equal(parsed.summary.totalDue, 3128675);

  assert.deepEqual(parsed.rows.map(shape), [
    '2026-05-23 debit 1240.00 Watsons Alabang Town',
    '2026-05-27 debit 689.75 National Book Store',
    '2026-06-01 credit 15400.00 Payment Received',
    '2026-06-03 debit 2499.00 Globe Telecom Postpaid',
    '2026-06-08 debit 845.00 Jollibee BF Paranaque',
    '2026-06-11 debit 12308.00 Agoda Singapore',
    '2026-06-14 credit 2100.00 Refund - Agoda',
    '2026-06-17 debit 1204.00 Finance Charge',
  ]);

  // Every row was decided by geometry, not by guessing from the wording.
  assert.ok(parsed.rows.every((row) => row.reason === 'column'), 'expected column-derived directions');
});

/* ── UnionBank: DD MMM YY dates, "Please Pay On Or Before" ────────────── */

test('UnionBank card statement', () => {
  const parsed = parseFixture('unionbank-card-aes128.pdf', '1140');

  assert.equal(parsed.summary.issuer, 'UnionBank');
  assert.equal(parsed.summary.accountHint, '1140');
  assert.equal(parsed.summary.statementDate, '2026-06-22');
  // "Please Pay On Or Before" is a due date by another name.
  assert.equal(parsed.summary.dueDate, '2026-07-12');
  // As is "Outstanding Balance" for the total due.
  assert.equal(parsed.summary.totalDue, 1904310);
  assert.equal(parsed.summary.minimumDue, 95216);

  assert.deepEqual(parsed.rows.map(shape), [
    '2026-05-28 debit 3120.00 Puregold Price Club',
    '2026-05-30 debit 6890.00 Cebu Pacific Air',
    '2026-06-02 credit 10000.00 Payment - Thank You',
    '2026-06-05 debit 2340.50 Lazada E-Services',
    '2026-06-09 debit 4166.60 Installment - Appliance 3/12',
    '2026-06-14 debit 500.00 Late Payment Charge',
    '2026-06-18 debit 26.00 Documentary Stamp Tax',
  ]);
});

/* ── RCBC: withdrawals / deposits / running balance ───────────────────── */

test('RCBC savings statement ignores the running balance column', () => {
  const parsed = parseFixture('rcbc-savings-aes256.pdf', 'mypassword');

  assert.equal(parsed.summary.issuer, 'RCBC');
  assert.equal(parsed.kind, 'bank');
  assert.equal(parsed.summary.periodFrom, '2026-06-01');
  assert.equal(parsed.summary.periodTo, '2026-06-30');

  assert.deepEqual(parsed.rows.map(shape), [
    '2026-06-02 credit 10000.00 INSTAPAY Transfer From BPI',
    '2026-06-04 debit 3000.00 ATM Withdrawal RCBC Makati',
    '2026-06-08 debit 4238.90 PESONET - MERALCO',
    '2026-06-15 credit 68000.00 Salary Credit',
    '2026-06-19 debit 1120.40 Bills Payment - Maynilad',
    '2026-06-26 debit 5430.25 POS Purchase SM Megamall',
    '2026-06-30 credit 12.85 Interest Earned',
  ]);

  // The balance column is never mistaken for an amount.
  assert.ok(parsed.rows.every((row) => row.amount < 10_000_000));
});

test('a statement naming another bank in a transaction is still its own bank', () => {
  // The RCBC statement contains "INSTAPAY TRANSFER FROM BPI". The masthead
  // decides, not whichever bank name appears first in the pattern list.
  const bytes = new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures/rcbc-savings-aes256.pdf')));
  const { lines } = readPdfText(bytes, 'mypassword');
  assert.equal(detectIssuer(lines), 'RCBC');
});

/* ── Summary lines are never transactions ─────────────────────────────── */

test('totals and header figures do not become transactions', () => {
  for (const [file, password] of [
    ['bdo-card-aes256.pdf', '7788'],
    ['bpi-card-rc4.pdf', '0620'],
    ['unionbank-card-aes128.pdf', '1140'],
    ['rcbc-savings-aes256.pdf', 'mypassword'],
  ] as Array<[string, string]>) {
    const parsed = parseFixture(file, password);
    for (const row of parsed.rows) {
      assert.doesNotMatch(
        row.description,
        /total amount due|minimum|credit limit|previous balance|beginning balance|statement date/i,
        `${file}: "${row.description}" is a summary line, not a transaction`,
      );
    }
  }
});

/* ── Descriptions ─────────────────────────────────────────────────────── */

test('descriptions soften shouting without mangling acronyms', () => {
  assert.equal(cleanDescription('SM SUPERMARKET MAKATI'), 'SM Supermarket Makati');
  assert.equal(cleanDescription('ATM WITHDRAWAL RCBC MAKATI'), 'ATM Withdrawal RCBC Makati');
  assert.equal(cleanDescription('PAYMENT - THANK YOU'), 'Payment - Thank You');
  assert.equal(cleanDescription('DOCUMENTARY STAMP TAX'), 'Documentary Stamp Tax');
  // Mixed case is left exactly as the statement wrote it.
  assert.equal(cleanDescription('Netflix.com Amsterdam'), 'Netflix.com Amsterdam');
});

test('descriptions lose long reference numbers but keep the merchant', () => {
  assert.equal(cleanDescription('GRAB *TRIP  REF NO 8829301827'), 'Grab *TRIP');
  assert.equal(cleanDescription('SHOPEE PH 123456789012345'), 'Shopee PH');
});
