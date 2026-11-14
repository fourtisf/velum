/**
 * Redis contract between apps/workers (writers) and apps/api (readers).
 * All money values are decimal strings. Times are unix milliseconds.
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
} as const;

export const SPARK_POINTS = 60;
export const SPARK_INTERVAL_MS = 60_000;
export const CANDLE_CACHE_SIZE = 300;

export type PriceSource = 'demo' | 'chainlink';

export interface MarketSnapshot {
  symbol: string;
  price: string;
  mark: string;
  open24h: string;
  /** Last hour, one point per minute, oldest first. The last point tracks the live price. */
  spark: string[];
  source: PriceSource;
  updatedAt: number;
}

export interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
}
