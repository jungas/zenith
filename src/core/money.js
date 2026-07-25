/**
 * Money is stored everywhere in this app as **integer cents**.
 * Floats are never used for balances, budgets or interest accrual results —
 * they are only an intermediate in rate math, and are rounded back to cents
 * immediately.
 *
 * Sign convention (from the account's point of view):
 *   negative = money leaving the account / debt increasing
 *   positive = money entering the account / debt decreasing
 */

/** Parse user input ("1,234.56", "$12", "-4.5") into integer cents. */
export function parseMoney(input) {
  if (typeof input === 'number') return Math.round(input * 100);
  if (input == null) return 0;
  const cleaned = String(input).replace(/[^0-9.,\-]/g, '').replace(/,/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return 0;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

/** Cents -> plain decimal string, for prefilling number inputs. */
export function centsToInput(cents) {
  return (Math.abs(cents) / 100).toFixed(2);
}

const formatterCache = new Map();

function formatter(locale, currency, options) {
  const key = `${locale}|${currency}|${JSON.stringify(options)}`;
  let cached = formatterCache.get(key);
  if (!cached) {
    cached = new Intl.NumberFormat(locale, { style: 'currency', currency, ...options });
    formatterCache.set(key, cached);
  }
  return cached;
}

/**
 * Format cents as currency.
 * @param {number} cents
 * @param {{currency?: string, locale?: string, signed?: boolean, cents?: boolean}} [opts]
 */
export function formatMoney(cents, opts = {}) {
  const {
    currency = 'USD',
    locale = 'en-US',
    signed = false,
    cents: withCents = true,
  } = opts;
  const value = (cents || 0) / 100;
  const fmt = formatter(locale, currency, {
    minimumFractionDigits: withCents ? 2 : 0,
    maximumFractionDigits: withCents ? 2 : 0,
  });
  const out = fmt.format(Math.abs(value));
  if (cents < 0) return `-${out}`;
  if (signed && cents > 0) return `+${out}`;
  return out;
}

/** Compact currency for tiles and axis ticks: $1.2K, $4.2M. */
export function formatMoneyCompact(cents, opts = {}) {
  const { currency = 'USD', locale = 'en-US' } = opts;
  const abs = Math.abs(cents);
  if (abs < 100_000) return formatMoney(cents, { ...opts, cents: abs % 100 !== 0 });
  const fmt = formatter(locale, currency, {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const out = fmt.format(Math.abs(cents) / 100);
  return cents < 0 ? `-${out}` : out;
}

export function formatPercent(ratio, digits = 0) {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export const sum = (values) => values.reduce((total, n) => total + (n || 0), 0);

export const clampPositive = (cents) => (cents > 0 ? cents : 0);
