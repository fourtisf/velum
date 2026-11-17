import type { GeoLookup } from './geo';
import type { Candle, CandleCache, MarketSnapshot, Timeframe } from '@velum/config';
import type { OnchainStatus, SignerStatus } from '@velum/config/src/onchain';
import type { PerpRef } from '@velum/config/src/perps-ref';
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
  /** Real perps metrics per market from Lighter (mainnet), authenticated and validated; absent ones are left out. */
  perpRefs?(symbols: readonly string[]): Promise<Map<string, PerpRef>>;
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

/** The signer's status (on-chain audit M-2): written by velum-signer to a file the API may read but not write. */
export interface SignerReader {
  /** The parsed status, or null (no file: the signer is not running, or never was). */
  status(): Promise<SignerStatus | null>;
}

export interface AppDeps {
  env: ApiEnv;
  cache: CacheReader;
  /** Phase 3: the signer's status file (absent in tests that do not need it). */
  signer?: SignerReader;
  db: DbReader;
  chain: ChainReader;
  /** Phase 3: the deployment file of the configured chain (none: the Phase 3 routes answer 404). */
  deployment?: DeploymentSource;
  /** Phase 3: the indexer's tables. */
  onchain?: OnchainReader;
  /** ioredis client for the shared rate-limit store; omitted in tests (in-memory store). */
  rateLimitRedis?: unknown;
  /** The visitor's country for the perps geoblock (lib/geo.ts); absent: unknown. */
  geo?: GeoLookup;
  /** Where client error reports are kept (a capped Redis list in production). */
  clientErrors?: ClientErrorSink;
  now?: () => number;
  /** Extra cleanup on app.close(), e.g. disconnect Prisma and Redis. */
  onClose?: () => Promise<void>;
}

/** One error the web reported (routes/client-errors.ts), already scrubbed of addresses and long hex. */
export interface ClientErrorRecord {
  at: number;
  kind: string;
  message: string;
  stack: string;
  path: string;
  release: string;
}

export interface ClientErrorSink {
  push(rec: ClientErrorRecord): Promise<void>;
  recent(n: number): Promise<ClientErrorRecord[]>;
}
