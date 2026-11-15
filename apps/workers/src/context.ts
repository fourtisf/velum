import type { MarketSnapshot, Timeframe } from '@velum/config';
import type { PrismaClient } from '@velum/db';
import type { Redis } from 'ioredis';
import type { WorkerEnv } from './env';
import type { WadCandle } from './lib/candles';
import type { Logger } from './lib/log';
import type { PriceReader } from './sources';

export const PRICE_WORKER = 'price-relay';
export const CANDLES_WORKER = 'candles';

/**
 * A candle job. Only `at` is read from a queued job: the worker loads the prices of that tick from
 * PriceTick in Postgres (jobs/candles.ts, audit M-2). `prices` is what price-relay read, kept for tests
 * and logs.
 */
export interface CandleJobData {
  at: number;
  /** symbol -> decimal price string */
  prices: Record<string, string>;
}

export const seriesKey = (symbol: string, tf: Timeframe) => `${symbol}:${tf}`;

/** In-process state. The workers app runs as a single PM2 fork, so memory is authoritative between ticks. */
export interface WorkerContext {
  env: WorkerEnv;
  prisma: PrismaClient;
  redis: Redis;
  log: Logger;
  source: PriceReader;
  /** symbol -> Market.id */
  marketIds: Map<string, string>;
  snapshots: Map<string, MarketSnapshot>;
  /** symbol -> open price 24h ago (decimal string) */
  open24h: Map<string, string>;
  lastOpenRefresh: number;
  /** seriesKey -> last CANDLE_CACHE_SIZE candles, oldest first. Only advanced after Postgres accepted the tick. */
  series: Map<string, WadCandle[]>;
  /** symbol -> time of the newest tick folded into candles (a retried older tick must not move the close back). */
  lastTickAt: Map<string, number>;
  /** When runPriceRelay last ran (it skips runs closer than half a poll interval, audit M-2). */
  lastRelayAt?: number;
  enqueueCandles(data: CandleJobData): Promise<void>;
}
