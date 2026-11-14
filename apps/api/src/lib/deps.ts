import type { Candle, MarketSnapshot, Timeframe } from '@velum/config';
import type { ApiEnv } from '../env';

/** Reads what the workers write to Redis (see packages/config/src/cache.ts). */
export interface CacheReader {
  ping(): Promise<boolean>;
  snapshots(symbols: readonly string[]): Promise<Map<string, MarketSnapshot>>;
  candles(symbol: string, tf: Timeframe): Promise<Candle[] | null>;
  heartbeat(worker: string): Promise<number | null>;
}

export interface PublishedPool {
  symbol: string;
  feeBps: number;
  sizeRounded: string;
  aprEst: string;
  hour: number;
}

export interface DbReader {
  ping(): Promise<boolean>;
  candles(symbol: string, tf: Timeframe, limit: number): Promise<Candle[]>;
  publishedPools(): Promise<PublishedPool[]>;
}

export interface ChainReader {
  /** Latest block number, or null when the RPC is unreachable. Cached briefly. */
  blockNumber(): Promise<bigint | null>;
}

export interface AppDeps {
  env: ApiEnv;
  cache: CacheReader;
  db: DbReader;
  chain: ChainReader;
  /** ioredis client for the shared rate-limit store; omitted in tests (in-memory store). */
  rateLimitRedis?: unknown;
  now?: () => number;
  /** Extra cleanup on app.close(), e.g. disconnect Prisma and Redis. */
  onClose?: () => Promise<void>;
}
