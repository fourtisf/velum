/**
 * Redis contract between apps/workers (writers) and apps/api (readers).
 * All money values are decimal strings. Times are unix milliseconds.
 *
 * Redis is not trusted (audit M-2): on a shared server another tenant may write Velum's keys. Readers
 * therefore parse every value with parseSnapshot / parseCandles / parseHeartbeat below, which accept
 * only well-formed, bounded values that are not dated in the future; anything else counts as missing.
 */
import type { Timeframe } from './index';

export const CACHE_PREFIX = 'velum';

export const cacheKeys = {
  /** JSON MarketSnapshot, written by price-relay every PRICE_POLL_MS. */
  price: (symbol: string) => `${CACHE_PREFIX}:price:${symbol}`,
  /** JSON Candle[] (oldest first, up to CANDLE_CACHE_SIZE), written by the candles job. */
  candles: (symbol: string, tf: Timeframe) => `${CACHE_PREFIX}:candles:${symbol}:${tf}`,
  /** Unix ms of the last successful price-relay run. */
  heartbeat: (worker: string) => `${CACHE_PREFIX}:heartbeat:${worker}`,
  /** Unix ms when demo data was backfilled (prevents re-seeding on restart). */
  demoSeeded: () => `${CACHE_PREFIX}:demo:seeded`,
  /** Price source the stored history was built from; a change to a real source purges demo history. */
  priceSource: () => `${CACHE_PREFIX}:price-source`,
} as const;

export const SPARK_POINTS = 60;
export const SPARK_INTERVAL_MS = 60_000;
export const CANDLE_CACHE_SIZE = 300;
/** Clock skew allowed between processes: anything dated further ahead than this is rejected. */
export const MAX_FUTURE_SKEW_MS = 30_000;

/** demo = simulated; robinhood = official quotes from api.robinhood.com/rhj/prices; chainlink = on-chain feeds. */
export type PriceSource = 'demo' | 'robinhood' | 'chainlink';
export const PRICE_SOURCES: readonly PriceSource[] = ['demo', 'robinhood', 'chainlink'];

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
  return {
    symbol,
    price: v.price,
    mark: v.mark,
    open24h: v.open24h,
    spark: [...v.spark],
    source: v.source as PriceSource,
    updatedAt: v.updatedAt,
    ...(v.checkedAt !== undefined ? { checkedAt: v.checkedAt } : {}),
  };
}

/**
 * A cached candle series for timeframe `bucketMs`, or null when anything is off: not an array, more than
 * CANDLE_CACHE_SIZE candles, a bucket time that is not aligned, not increasing or ahead of `now`, a price
 * outside (0, 1e9), or a low/high that does not bracket open and close.
 */
export function parseCandles(raw: unknown, bucketMs: number, now: number): Candle[] | null {
  const v = parse(raw, MAX_CANDLES_BYTES);
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

/** A heartbeat (Unix ms) read from Redis, or null when missing, malformed or dated ahead of `now`. */
export function parseHeartbeat(raw: unknown, now: number): number | null {
  if (typeof raw !== 'string' || !/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return isTime(n, now) ? n : null;
}
