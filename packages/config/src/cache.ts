/**
 * Redis contract between apps/workers (writers) and apps/api (readers).
 * All money values are decimal strings. Times are unix milliseconds.
 *
 * Redis is not trusted (audit M-2, F-2): on a shared server another tenant may write Velum's keys.
 * Price snapshots, candle caches and heartbeats are therefore stored authenticated (cache-mac.ts: an
 * HMAC under a key derived from DATABASE_URL, which only the API and the workers have). Readers check
 * the MAC first, then parse the payload with parseSnapshot / parseCandleCache / parseHeartbeat below,
 * which accept only well-formed, bounded values that are not dated in the future. A value with a bad or
 * missing MAC, or one that fails parsing, counts as missing.
 */
import type { NetworkName, Timeframe } from './index';

export const CACHE_PREFIX = 'velum';

export const cacheKeys = {
  /** JSON MarketSnapshot (authenticated), written by price-relay every PRICE_POLL_MS. */
  price: (symbol: string) => `${CACHE_PREFIX}:price:${symbol}`,
  /** JSON CandleCache (authenticated): up to CANDLE_CACHE_SIZE candles, oldest first, with their source and network. */
  candles: (symbol: string, tf: Timeframe) => `${CACHE_PREFIX}:candles:${symbol}:${tf}`,
  /** Unix ms (authenticated) of a worker's last successful run. */
  heartbeat: (worker: string) => `${CACHE_PREFIX}:heartbeat:${worker}`,
  /** Unix ms when demo data was backfilled (prevents re-seeding on restart). */
  demoSeeded: () => `${CACHE_PREFIX}:demo:seeded`,
  /** Price source the workers last started with (informational; history decisions rest on Postgres). */
  priceSource: () => `${CACHE_PREFIX}:price-source`,
} as const;

export const SPARK_POINTS = 60;
export const SPARK_INTERVAL_MS = 60_000;
export const CANDLE_CACHE_SIZE = 300;
/** Clock skew allowed between processes: anything dated further ahead than this is rejected. */
export const MAX_FUTURE_SKEW_MS = 30_000;

/**
 * demo = simulated; robinhood = official quotes from api.robinhood.com/rhj/prices (24/5, frozen while the US session is
 * closed); chainlink = on-chain feeds; uniswap = the curated Uniswap pools on Robinhood Chain mainnet, where Stock
 * Tokens trade 24/7 (price = the deepest pool's current price, candles = real swaps; src/uniswap.ts).
 */
export type PriceSource = 'demo' | 'robinhood' | 'chainlink' | 'uniswap';
export const PRICE_SOURCES: readonly PriceSource[] = ['demo', 'robinhood', 'chainlink', 'uniswap'];
/** Sources of real prices: the only ones mainnet shows, live or as history. */
export const REAL_PRICE_SOURCES: readonly PriceSource[] = ['robinhood', 'chainlink', 'uniswap'];

/**
 * The kind of history a source writes. Candles of different kinds are never mixed (index.ts resets stored history
 * when the kind changes): simulated prices, quotes of the underlying stock (Robinhood, Chainlink: one price per poll,
 * frozen while the US session is closed) and onchain trades (Uniswap swaps, 24/7).
 */
export type PriceKind = 'demo' | 'quote' | 'dex';
export const priceKindOf = (s: PriceSource): PriceKind => (s === 'demo' ? 'demo' : s === 'uniswap' ? 'dex' : 'quote');
/** Sources whose market trades 24/7 onchain: the US session calendar and the frozen-quote rule do not apply. */
export const isAlwaysOpenSource = (s: PriceSource | string | null | undefined): boolean => s === 'uniswap';

export interface MarketSnapshot {
  symbol: string;
  price: string;
  mark: string;
  open24h: string;
  /** Last hour, one point per minute, oldest first. The last point tracks the live price. */
  spark: string[];
  source: PriceSource;
  /**
   * The quote time (audit M-1): when the quote behind `price` was produced or last changed (a new
   * Robinhood bid/ask, a Chainlink round, a demo tick). A quote the source keeps repeating unchanged
   * (a closed market) keeps its old updatedAt.
   */
  updatedAt: number;
  /**
   * When price-relay last read this quote from the source (the pipeline is alive). Absent in snapshots
   * written before November 2026; readers then use updatedAt.
   */
  checkedAt?: number;
  /**
   * Set while price-relay has not yet seen the quote change since it started reading it without a
   * previous snapshot (audit F-6): the quote time is then unknown, so the price is not live until the
   * quote changes (or the session calendar says closed). Never set for demo prices or for quotes the
   * source dates itself (a Chainlink round).
   */
  unconfirmed?: true;
}

export interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
}

/** A positive decimal string below 1e9 (the price bound every source enforces), at most 18 decimals. */
const PRICE_RE = /^\d{1,9}(\.\d{1,18})?$/;
export const isPriceString = (v: unknown): v is string => typeof v === 'string' && PRICE_RE.test(v) && /[1-9]/.test(v);

const isTime = (v: unknown, now: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= now + MAX_FUTURE_SKEW_MS;

/** Raw JSON larger than this is never parsed (a 60-point snapshot is well under 2 KB). */
export const MAX_SNAPSHOT_BYTES = 8 * 1024;
/** Raw JSON larger than this is never parsed (300 candles are about 30 KB). */
export const MAX_CANDLES_BYTES = 128 * 1024;
/** A heartbeat payload is a Unix ms number. */
export const MAX_HEARTBEAT_BYTES = 16;

const parse = (raw: unknown, max: number): unknown => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > max) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * A snapshot read from Redis for `symbol`, or null when it is malformed, oversized, for another symbol,
 * has an unknown source, a price outside (0, 1e9), more than SPARK_POINTS spark points, or a time
 * further than MAX_FUTURE_SKEW_MS ahead of `now` (audit M-2: such a value would look live forever).
 */
export function parseSnapshot(raw: unknown, symbol: string, now: number): MarketSnapshot | null {
  const v = parse(raw, MAX_SNAPSHOT_BYTES) as Partial<MarketSnapshot> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (v.symbol !== symbol || !PRICE_SOURCES.includes(v.source as PriceSource)) return null;
  if (!isPriceString(v.price) || !isPriceString(v.mark) || !isPriceString(v.open24h)) return null;
  if (!Array.isArray(v.spark) || v.spark.length < 1 || v.spark.length > SPARK_POINTS || !v.spark.every(isPriceString)) return null;
  if (!isTime(v.updatedAt, now)) return null;
  if (v.checkedAt !== undefined && (!isTime(v.checkedAt, now) || v.checkedAt < v.updatedAt - MAX_FUTURE_SKEW_MS)) return null;
  if (v.unconfirmed !== undefined && v.unconfirmed !== true) return null;
  return {
    symbol,
    price: v.price,
    mark: v.mark,
    open24h: v.open24h,
    spark: [...v.spark],
    source: v.source as PriceSource,
    updatedAt: v.updatedAt,
    ...(v.checkedAt !== undefined ? { checkedAt: v.checkedAt } : {}),
    ...(v.unconfirmed ? { unconfirmed: true as const } : {}),
  };
}

/**
 * A candle series (a parsed JSON array) for timeframe `bucketMs`, or null when anything is off: not an
 * array, more than CANDLE_CACHE_SIZE candles, a bucket time that is not aligned, not increasing or ahead
 * of `now`, a price outside (0, 1e9), or a low/high that does not bracket open and close.
 */
function candleSeries(v: unknown, bucketMs: number, now: number): Candle[] | null {
  if (!Array.isArray(v) || v.length > CANDLE_CACHE_SIZE) return null;
  const out: Candle[] = [];
  let prev = -Infinity;
  for (const c of v as Array<Partial<Candle>>) {
    if (!c || typeof c !== 'object') return null;
    if (!isTime(c.t, now) || c.t % bucketMs !== 0 || c.t <= prev) return null;
    if (!isPriceString(c.o) || !isPriceString(c.h) || !isPriceString(c.l) || !isPriceString(c.c)) return null;
    const [o, h, l, cl] = [Number(c.o), Number(c.h), Number(c.l), Number(c.c)];
    if (l > Math.min(o, cl) || h < Math.max(o, cl)) return null;
    prev = c.t;
    out.push({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c });
  }
  return out;
}

/**
 * What the candles job caches per market and timeframe (audit F-3): the series, the price source it was
 * built from and the network it was written on, all covered by the MAC, so a mainnet reader can refuse
 * simulated history that an earlier testnet run left in Redis.
 */
export interface CandleCache {
  network: NetworkName;
  source: PriceSource;
  candles: Candle[];
}

/** The JSON payload stored for a CandleCache. */
export const candleCachePayload = (c: CandleCache): string => JSON.stringify({ network: c.network, source: c.source, candles: c.candles });

/**
 * A CandleCache payload, or null when it is malformed, oversized, names an unknown network or source, or
 * its candles fail the checks of candleSeries above.
 */
export function parseCandleCache(raw: unknown, bucketMs: number, now: number): CandleCache | null {
  const v = parse(raw, MAX_CANDLES_BYTES) as Partial<CandleCache> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if ((v.network !== 'testnet' && v.network !== 'mainnet') || !PRICE_SOURCES.includes(v.source as PriceSource)) return null;
  const candles = candleSeries(v.candles, bucketMs, now);
  return candles ? { network: v.network, source: v.source as PriceSource, candles } : null;
}

/** A heartbeat (Unix ms) read from Redis, or null when missing, malformed or dated ahead of `now`. */
export function parseHeartbeat(raw: unknown, now: number): number | null {
  if (typeof raw !== 'string' || !/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return isTime(n, now) ? n : null;
}
