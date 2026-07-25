/**
 * Dates are stored as plain 'YYYY-MM-DD' strings and months as 'YYYY-MM'.
 * Everything is treated as a calendar date in the user's own timezone — we
 * never construct a Date from a bare ISO string (that would parse as UTC and
 * shift the day backwards for anyone west of Greenwich).
 */

export function todayISO(now = new Date()) {
  return toISO(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function toISO(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' -> local Date at midnight. */
export function parseISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** 'YYYY-MM-DD' -> 'YYYY-MM' */
export function monthOf(iso) {
  return String(iso).slice(0, 7);
}

export function currentMonth(now = new Date()) {
  return monthOf(todayISO(now));
}

export function addMonths(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function compareMonths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inclusive list of month keys from `from` to `to`. */
export function monthRange(from, to) {
  const out = [];
  let cursor = from;
  let guard = 0;
  while (compareMonths(cursor, to) <= 0 && guard++ < 2400) {
    out.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return out;
}

export function daysInMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

export function monthLabel(monthKey, locale = 'en-US', opts = { month: 'long', year: 'numeric' }) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(locale, opts);
}

export function monthLabelShort(monthKey, locale = 'en-US') {
  return monthLabel(monthKey, locale, { month: 'short' });
}

export function formatDate(iso, locale = 'en-US', opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  return parseISO(iso).toLocaleDateString(locale, opts);
}

export function formatDateShort(iso, locale = 'en-US') {
  return formatDate(iso, locale, { month: 'short', day: 'numeric' });
}

/** Whole days from `fromISO` to `toISO` (negative when `toISO` is in the past). */
export function daysBetween(fromISO, toISO_) {
  const ms = parseISO(toISO_).getTime() - parseISO(fromISO).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * The next occurrence of a day-of-month on or after `fromISO`.
 * A day beyond the month's length clamps to the last day (a "31st" due date
 * lands on Feb 28/29 rather than rolling into March).
 */
export function nextDayOfMonth(dayOfMonth, fromISO_ = todayISO()) {
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
export function relativeDays(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}
