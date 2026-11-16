/**
 * Real perps metrics for the trade terminal while Velum's own perps are not live on mainnet: the Stock Token perps on
 * Lighter, the perps venue of Robinhood Chain (public REST API, no key). Shown as a labelled reference ("Lighter"),
 * never as Velum's own market. Pure and dependency-free: the workers fetch and validate, the API serves, the web shows.
 *
 * Checked 2026-11-16 against the live API (mainnet.zklighter.elliot.ai):
 *  - GET /api/v1/orderBookDetails?market_id=N returns one market with `symbol`, `market_type` "perp", `status`,
 *    `is_frozen`, `mark_price`, `index_price` (decimal strings) and `open_interest` (base units, one side: Lighter's
 *    `open_interest_usd` equals 2 x open_interest x mark_price, both sides).
 *  - GET /api/v1/funding-rates returns `funding_rates: [{ market_id, exchange, symbol, rate }]` for several venues; the
 *    `exchange: "lighter"` entry is the predicted rate as a fraction per 8 hours, signed (positive: longs pay). Lighter
 *    settles funding hourly: /api/v1/fundings (resolution 1h) lists settled hourly rates in percent with the paying
 *    side, and for TSLA, AAPL, META and NVDA the 8-hour figure equalled exactly 8 x the last hourly rate; ARB (negative,
 *    shorts paying) confirmed the sign. So funding per hour in percent = rate x 100 / 8.
 *  - NFLX has no Lighter market: it shows no reference.
 */

export const LIGHTER_API = 'https://mainnet.zklighter.elliot.ai';
export const LIGHTER_VENUE = 'lighter' as const;
export type PerpVenue = typeof LIGHTER_VENUE;

/** Velum symbol -> Lighter market id (each checked against the symbol the API returns for it). */
export const LIGHTER_MARKETS: Readonly<Record<string, number>> = {
  TSLA: 112,
  AMZN: 114,
  PLTR: 111,
  NVDA: 110,
  AMD: 138,
  AAPL: 113,
  META: 117,
  MSFT: 115,
  COIN: 109,
};

/** A reference older than this is not served (the workers refresh every minute). */
export const PERP_REF_MAX_AGE_MS = 5 * 60_000;
/** Lighter's hard funding clamp is 4% per hour: anything beyond is not a funding rate. */
export const PERP_REF_MAX_FUNDING_PCT = 4;

/** What the workers store per market (Redis, authenticated) and the API serves. Decimal strings. */
export interface PerpRef {
  symbol: string;
  venue: PerpVenue;
  /** Lighter's market id. */
  market: number;
  /** Mark price (USDC per token). */
  mark: string;
  /** Index price (USDC per token). */
  index: string;
  /** Predicted funding per hour, percent, signed: positive = longs pay. Up to 6 decimals. */
  fundingPerHour: string;
  /** Open interest, one side, in USD at the mark price, 2 decimals. */
  openInterest: string;
  /** When the workers read it (Unix ms). */
  at: number;
}

const DEC = /^\d{1,12}(\.\d{1,18})?$/;
const SIGNED = /^-?\d{1,3}(\.\d{1,6})?$/;
const isPos = (v: unknown): v is string => typeof v === 'string' && DEC.test(v) && /[1-9]/.test(v);
const isNonNeg = (v: unknown): v is string => typeof v === 'string' && DEC.test(v);

/** Exact decimal multiply of two non-negative decimal strings, rounded down to `dp` decimals. */
export function mulDecimal(a: string, b: string, dp: number): string {
  const split = (s: string): [bigint, number] => {
    const [i, f = ''] = s.split('.');
    return [BigInt(i! + f), f.length];
  };
  const [x, xd] = split(a);
  const [y, yd] = split(b);
  const scale = xd + yd;
  let p = x * y;
  if (scale > dp) p /= 10n ** BigInt(scale - dp);
  else p *= 10n ** BigInt(dp - scale);
  const s = p.toString().padStart(dp + 1, '0');
  return dp ? `${s.slice(0, -dp)}.${s.slice(-dp)}` : s;
}

/** Hourly funding in percent (string, 6 decimals, signed) from Lighter's 8-hour fraction, or null when implausible. */
export function lighterHourlyFundingPct(rate8hFraction: unknown): string | null {
  if (typeof rate8hFraction !== 'number' || !Number.isFinite(rate8hFraction)) return null;
  const pct = (rate8hFraction * 100) / 8;
  if (Math.abs(pct) > PERP_REF_MAX_FUNDING_PCT) return null;
  const r = Math.round(pct * 1e6) / 1e6;
  return (Object.is(r, -0) ? 0 : r).toFixed(6);
}

/**
 * The reference for `symbol` from one orderBookDetails entry and the funding-rates list, or null when anything is off:
 * another symbol or market id, not an active unfrozen perp, a price or open interest that is not a plain positive
 * decimal, or no plausible Lighter funding entry for the market.
 */
export function lighterRef(symbol: string, detail: unknown, fundingRates: unknown, at: number): PerpRef | null {
  const market = LIGHTER_MARKETS[symbol];
  if (market === undefined || !detail || typeof detail !== 'object') return null;
  const d = detail as Record<string, unknown>;
  if (d.symbol !== symbol || d.market_id !== market || d.market_type !== 'perp' || d.status !== 'active' || d.is_frozen !== false) return null;
  if (!isPos(d.mark_price) || !isPos(d.index_price)) return null;
  const oi = typeof d.open_interest === 'number' && Number.isFinite(d.open_interest) && d.open_interest >= 0 ? d.open_interest.toString() : d.open_interest;
  if (!isNonNeg(oi)) return null;
  if (!Array.isArray(fundingRates)) return null;
  const f = (fundingRates as Array<Record<string, unknown>>).find((x) => x && x.exchange === LIGHTER_VENUE && x.market_id === market && x.symbol === symbol);
  const fundingPerHour = lighterHourlyFundingPct(f?.rate);
  if (fundingPerHour === null) return null;
  return { symbol, venue: LIGHTER_VENUE, market, mark: d.mark_price, index: d.index_price, fundingPerHour, openInterest: mulDecimal(oi, d.mark_price, 2), at };
}

/** A PerpRef read back from Redis for `symbol`, or null when malformed, for another symbol or dated ahead of `now`. */
export function parsePerpRef(raw: unknown, symbol: string, now: number): PerpRef | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let v: Partial<PerpRef>;
  try {
    v = JSON.parse(raw) as Partial<PerpRef>;
  } catch {
    return null;
  }
  const market = LIGHTER_MARKETS[symbol];
  if (!v || typeof v !== 'object' || market === undefined || v.symbol !== symbol || v.venue !== LIGHTER_VENUE || v.market !== market) return null;
  if (!isPos(v.mark) || !isPos(v.index) || !isNonNeg(v.openInterest) || typeof v.fundingPerHour !== 'string' || !SIGNED.test(v.fundingPerHour)) return null;
  if (typeof v.at !== 'number' || !Number.isSafeInteger(v.at) || v.at <= 0 || v.at > now + 30_000) return null;
  return { symbol, venue: LIGHTER_VENUE, market, mark: v.mark, index: v.index, fundingPerHour: v.fundingPerHour, openInterest: v.openInterest, at: v.at };
}
