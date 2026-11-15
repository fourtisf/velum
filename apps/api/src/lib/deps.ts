import type { Candle, CandleCache, MarketSnapshot, Timeframe } from '@velum/config';
import type { OnchainStatus } from '@velum/config/src/onchain';
import type { ApiEnv } from '../env';
import type { DeploymentSource, OnchainReader } from './onchain';

/**
 * Reads what the workers write to Redis (see packages/config/src/cache.ts). Every value is authenticated
 * (audit F-2): one with a bad or missing MAC reads as missing.
 */
export interface CacheReader {
  ping(): Promise<boolean>;
  snapshots(symbols: readonly string[]): Promise<Map<string, MarketSnapshot>>;
  /** The cached series with the source it was built from (audit F-3), or null. */
  candles(symbol: string, tf: Timeframe): Promise<CandleCache | null>;
  heartbeat(worker: string): Promise<number | null>;
  /** The on-chain workers' status (Phase 3), authenticated and validated, or null (off, or not written). */
  onchainStatus?(): Promise<OnchainStatus | null>;
}

export interface PublishedPool {
  symbol: string;
  feeBps: number;
  sizeRounded: string;
  aprEst: string;
  hour: number;
}

export interface CandleQuery {
  /** Ignore buckets that start after this time (Unix ms): future rows are never served (audit L-1). */
  until?: number;
  /**
   * Only candles tagged with a real price source (robinhood or chainlink), used on mainnet (audit I-7):
   * demo candles and candles of unknown source (NULL, audit F-1, F-4) are never served as real history.
   */
  realOnly?: boolean;
}

export interface DbReader {
  ping(): Promise<boolean>;
  candles(symbol: string, tf: Timeframe, limit: number, query?: CandleQuery): Promise<Candle[]>;
  publishedPools(): Promise<PublishedPool[]>;
}

export interface ChainReader {
  /** Latest block number, or null when the RPC is unreachable. Cached briefly. */
  blockNumber(): Promise<bigint | null>;
  /** eth_chainId of RPC_URL, or null while the RPC has not answered (audit I-5). Cached. */
  chainId?(): Promise<number | null>;
}

export interface AppDeps {
  env: ApiEnv;
  cache: CacheReader;
  db: DbReader;
  chain: ChainReader;
  /** Phase 3: the deployment file of the configured chain (none: the Phase 3 routes answer 404). */
  deployment?: DeploymentSource;
  /** Phase 3: the indexer's tables. */
  onchain?: OnchainReader;
  /** ioredis client for the shared rate-limit store; omitted in tests (in-memory store). */
  rateLimitRedis?: unknown;
  now?: () => number;
  /** Extra cleanup on app.close(), e.g. disconnect Prisma and Redis. */
  onClose?: () => Promise<void>;
}
