/**
 * Money. Integer minor units in bigint, everywhere, with no exceptions.
 *
 * Floating point does not represent 0.1 BTC and it does not represent a
 * 12.7% autobet increase-on-loss step either. Every balance, stake, payout and
 * profit figure in ACE is a bigint count of the currency's smallest unit —
 * satoshis for BTC, cents for USD — and only ever becomes a string at the
 * moment it is rendered.
 */

export type MinorUnits = bigint;

export interface CurrencySpec {
  /** Ticker as the operator exposes it. */
  code: string;
  /** Display name. */
  name: string;
  /** Decimal places in the minor-unit representation. 8 for most crypto. */
  decimals: number;
  /** Decimals to actually show in the UI. Trailing places are noise on screen. */
  displayDecimals: number;
  kind: 'crypto' | 'fiat';
  /** Prefix for fiat display, e.g. '$'. */
  symbol?: string;
}

export const CURRENCIES: Record<string, CurrencySpec> = {
  BTC: { code: 'BTC', name: 'Bitcoin', decimals: 8, displayDecimals: 8, kind: 'crypto' },
  ETH: { code: 'ETH', name: 'Ethereum', decimals: 8, displayDecimals: 6, kind: 'crypto' },
  LTC: { code: 'LTC', name: 'Litecoin', decimals: 8, displayDecimals: 6, kind: 'crypto' },
  SOL: { code: 'SOL', name: 'Solana', decimals: 8, displayDecimals: 4, kind: 'crypto' },
  USDT: { code: 'USDT', name: 'Tether', decimals: 8, displayDecimals: 2, kind: 'crypto' },
  USD: { code: 'USD', name: 'US Dollar', decimals: 2, displayDecimals: 2, kind: 'fiat', symbol: '$' },
  EUR: { code: 'EUR', name: 'Euro', decimals: 2, displayDecimals: 2, kind: 'fiat', symbol: '€' },
};

export function currency(code: string): CurrencySpec {
  const spec = CURRENCIES[code];
  if (!spec) throw new Error(`Unknown currency: ${code}`);
  return spec;
}

/** Parse a human-entered decimal string into exact minor units. No Number involved. */
export function parseAmount(input: string, code: string): MinorUnits {
  const { decimals } = currency(code);
  const trimmed = input.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new Error(`Not a valid amount: ${input}`);
  }
  const [whole = '0', frac = ''] = trimmed.split('.');
  if (frac.length > decimals) {
    throw new Error(`${code} supports ${decimals} decimal places, got ${frac.length}`);
  }
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Exact decimal string for storage, logs and audit. Full precision, always. */
export function toExactString(units: MinorUnits, code: string): string {
  const { decimals } = currency(code);
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0');
  return `${neg ? '-' : ''}${whole}${decimals > 0 ? '.' + frac : ''}`;
}

/** Display string: trimmed to the currency's display precision, symbol applied. */
export function format(units: MinorUnits, code: string, opts: { withCode?: boolean } = {}): string {
  const spec = currency(code);
  const exact = toExactString(units, code);
  const [whole = '0', frac = ''] = exact.split('.');
  // Group the integer part only. Running the thousands separator over the whole
  // string turns 1.23456789 BTC into 1.23,456,789 BTC, which is the kind of
  // thing a player screenshots.
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const shownFrac = frac.padEnd(spec.displayDecimals, '0').slice(0, spec.displayDecimals);
  const shown = spec.displayDecimals > 0 ? `${groupedWhole}.${shownFrac}` : groupedWhole;
  const body = spec.symbol ? `${spec.symbol}${shown}` : shown;
  return opts.withCode && !spec.symbol ? `${body} ${spec.code}` : body;
}

/**
 * Carry as an exact integer in hundredths, e.g. 2.41x -> 241.
 * Every multiplier in the system crosses into money through this, never
 * through a float multiply.
 */
export function carryToHundredths(carry: number): bigint {
  return BigInt(Math.round(carry * 100));
}

/**
 * Payout for a stake at a settled carry. Truncates toward zero at the
 * sub-minor-unit boundary, which rounds in the house's favour by at most one
 * satoshi. Documented in the paytable; consistent with every operator we would
 * place this title with.
 */
export function payoutFor(stake: MinorUnits, carry: number): MinorUnits {
  return (stake * carryToHundredths(carry)) / 100n;
}

/** Profit = payout - stake. Negative on a bust. */
export function profitFor(stake: MinorUnits, carry: number): MinorUnits {
  return payoutFor(stake, carry) - stake;
}

/** Percentage step used by autobet increase-on-win / increase-on-loss. */
export function applyPercent(units: MinorUnits, percent: number): MinorUnits {
  // percent carries 2 decimals of precision (e.g. 12.75%) -> basis points.
  const bps = BigInt(Math.round(percent * 100));
  return units + (units * bps) / 10_000n;
}

export function clamp(units: MinorUnits, min: MinorUnits, max: MinorUnits): MinorUnits {
  return units < min ? min : units > max ? max : units;
}

export function maxOf(a: MinorUnits, b: MinorUnits): MinorUnits {
  return a > b ? a : b;
}
