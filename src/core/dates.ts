/**
 * Dates are stored as plain 'YYYY-MM-DD' strings and months as 'YYYY-MM'.
 * Everything is treated as a calendar date in the user's own timezone — we
 * never construct a Date from a bare ISO string (that would parse as UTC and
 * shift the day backwards for anyone west of Greenwich).
 */

import type { ISODate, MonthKey } from './model.ts';

export function todayISO(now: Date = new Date()): ISODate {
  return toISO(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function toISO(year: number, month: number, day: number): ISODate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' -> local Date at midnight. */
export function parseISO(iso: ISODate): Date {
  const [y = 1970, m = 1, d = 1] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Shift a calendar date by whole days, forwards or back. */
export function addDays(iso: ISODate, delta: number): ISODate {
  const date = parseISO(iso);
  date.setDate(date.getDate() + delta);
  return toISO(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** 'YYYY-MM-DD' -> 'YYYY-MM' */
export function monthOf(iso: ISODate): MonthKey {
  return String(iso).slice(0, 7);
}

export function currentMonth(now: Date = new Date()): MonthKey {
  return monthOf(todayISO(now));
}

export function addMonths(monthKey: MonthKey, delta: number): MonthKey {
  const [y = 0, m = 1] = monthKey.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/**
 * Shift a calendar date by whole months, clamping to the month's length.
 *
 * The 31st plus one month is the 28th of February, not the 3rd of March: a bill
 * due on the last day of the month is due on the last day of the *next* one,
 * and rolling over would quietly move it into the month after.
 */
export function addMonthsToDate(iso: ISODate, delta: number): ISODate {
  const date = parseISO(iso);
  const year = date.getFullYear();
  const month = date.getMonth() + delta;
  const last = new Date(year, month + 1, 0).getDate();
  const shifted = new Date(year, month, Math.min(date.getDate(), last));
  return toISO(shifted.getFullYear(), shifted.getMonth() + 1, shifted.getDate());
}

export function compareMonths(a: MonthKey, b: MonthKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inclusive list of month keys from `from` to `to`. */
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  let cursor = from;
  let guard = 0;
  while (compareMonths(cursor, to) <= 0 && guard++ < 2400) {
    out.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return out;
}

export function daysInMonth(monthKey: MonthKey): number {
  const [y = 0, m = 1] = monthKey.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

export function monthLabel(
  monthKey: MonthKey,
  locale = 'en-US',
  opts: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' },
): string {
  const [y = 0, m = 1] = monthKey.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(locale, opts);
}

export function monthLabelShort(monthKey: MonthKey, locale = 'en-US'): string {
  return monthLabel(monthKey, locale, { month: 'short' });
}

export function formatDate(
  iso: ISODate,
  locale = 'en-US',
  opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' },
): string {
  return parseISO(iso).toLocaleDateString(locale, opts);
}

export function formatDateShort(iso: ISODate, locale = 'en-US'): string {
  return formatDate(iso, locale, { month: 'short', day: 'numeric' });
}

/** Whole days from `fromISO` to `toISO` (negative when `toISO` is in the past). */
export function daysBetween(fromISO: ISODate, toISO_: ISODate): number {
  const ms = parseISO(toISO_).getTime() - parseISO(fromISO).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * The next occurrence of a day-of-month on or after `fromISO`.
 * A day beyond the month's length clamps to the last day (a "31st" due date
 * lands on Feb 28/29 rather than rolling into March).
 */
export function nextDayOfMonth(dayOfMonth: number, fromISO_: ISODate = todayISO()): ISODate {
  const from = parseISO(fromISO_);
  const day = Math.min(Math.max(Math.round(dayOfMonth) || 1, 1), 31);
  for (let offset = 0; offset < 3; offset++) {
    const year = from.getFullYear();
    const month = from.getMonth() + offset;
    const last = new Date(year, month + 1, 0).getDate();
    const candidate = new Date(year, month, Math.min(day, last));
    if (candidate >= from) {
      return toISO(candidate.getFullYear(), candidate.getMonth() + 1, candidate.getDate());
    }
  }
  return fromISO_;
}

/** "in 4 days" / "today" / "6 days ago" */
export function relativeDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}
