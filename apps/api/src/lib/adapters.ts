/** Production implementations of the readers in deps.ts (Redis, Prisma, viem). */
import {
  MAX_CANDLES_BYTES,
  MAX_HEARTBEAT_BYTES,
  MAX_SNAPSHOT_BYTES,
  REAL_PRICE_SOURCES,
  TIMEFRAME_MS,
  cacheKeys,
  parseCandleCache,
  parseHeartbeat,
  parseSnapshot,
  type Candle,
  type MarketSnapshot,
  type Timeframe,
} from '@velum/config';
import type { CacheMac } from '@velum/config/src/cache-mac';
import { Prisma, type PrismaClient } from '@velum/db';
import type { Redis } from 'ioredis';
import { createPublicClient, http } from 'viem';
import type { CacheReader, ChainReader, DbReader, PublishedPool } from './deps';
import { circuit, timeout } from './memo';

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);

/** Longest wait for one Redis read; the routes then answer degraded (audit L-4). */
export const REDIS_READ_TIMEOUT_MS = 250;
/** After a failed read, reads fail at once for this long (one timeout per outage, not one per request). */
export const REDIS_BREAKER_MS = 2000;

/**
 * Reads what the workers wrote. Redis may be shared with other tenants (audit M-2, F-2): every value
 * must carry a valid MAC (`mac`, keyed from DATABASE_URL, bound to the network and the Redis key) and is
 * then validated with the parsers in packages/config (cache.ts). Unauthenticated, malformed, oversized
 * or future-dated values, and candle caches written for another network, count as missing. Reads time
 * out after REDIS_READ_TIMEOUT_MS (rejecting) instead of waiting for the client's reconnects, and after a
 * failure they fail at once for REDIS_BREAKER_MS (ping is exempt: /v1/health must see the truth).
 */
export function redisCache(redis: Redis, opts: { mac: CacheMac; now?: () => number; timeoutMs?: number }): CacheReader {
  const { mac } = opts;
  const now = opts.now ?? Date.now;
  const ms = opts.timeoutMs ?? REDIS_READ_TIMEOUT_MS;
  const guarded = circuit(REDIS_BREAKER_MS);
  const read = <T>(p: () => Promise<T>) => guarded(() => timeout(p(), ms, 'Redis read'));
  return {
    async ping() {
      try {
        return (await withTimeout(redis.ping(), 500, 'TIMEOUT')) === 'PONG';
      } catch {
        return false;
      }
    },
    async snapshots(symbols) {
      const out = new Map<string, MarketSnapshot>();
      if (!symbols.length) return out;
      const keys = symbols.map((s) => cacheKeys.price(s));
      const raws = await read(() => redis.mget(...keys));
      const t = now();
      raws.forEach((raw, i) => {
        const snap = parseSnapshot(mac.open(keys[i]!, raw, MAX_SNAPSHOT_BYTES), symbols[i]!, t);
        if (snap) out.set(symbols[i]!, snap);
      });
      return out;
    },
    async candles(symbol, tf) {
      const key = cacheKeys.candles(symbol, tf);
      const raw = await read(() => redis.get(key));
      const cached = parseCandleCache(mac.open(key, raw, MAX_CANDLES_BYTES), TIMEFRAME_MS[tf], now());
      return cached && cached.network === mac.network ? cached : null;
    },
    async heartbeat(worker) {
      const key = cacheKeys.heartbeat(worker);
      return parseHeartbeat(mac.open(key, await read(() => redis.get(key)), MAX_HEARTBEAT_BYTES), now());
    },
  };
}

/** Prisma Decimal to a plain decimal string (no exponent notation). */
const dec = (d: { toFixed(): string }): string => d.toFixed();

/** Upper bound on rows the pools query can return (one per pool; far above the market count). */
export const MAX_POOLS = 100;

interface PublishedPoolRow {
  symbol: string;
  feeBps: number;
  sizeRounded: { toFixed(): string };
  aprEst: { toFixed(): string };
  hour: Date;
}

export const publishedPoolsSql = Prisma.sql`
  SELECT m."symbol", p."feeBps", ph."sizeRounded", ph."aprEst", ph."hour"
  FROM "Pool" p
  JOIN "Market" m ON m."id" = p."marketId"
  CROSS JOIN LATERAL (
    SELECT h."sizeRounded", h."aprEst", h."hour"
    FROM "PoolHourly" h
    WHERE h."poolId" = p."id" AND h."published" = true
    ORDER BY h."hour" DESC
    LIMIT 1
  ) ph
  ORDER BY m."symbol"
  LIMIT ${MAX_POOLS}`;

export function prismaDb(prisma: PrismaClient): DbReader {
  return {
    async ping() {
      const query = prisma.$queryRaw`SELECT 1`.then(
        () => true,
        () => false,
      );
      return withTimeout(query, 2000, false);
    },
    async candles(symbol, tf: Timeframe, limit, query = {}) {
      const rows = await prisma.candle.findMany({
        where: {
          tf,
          market: { symbol },
          ...(query.until !== undefined ? { t: { lte: new Date(query.until) } } : {}),
          // Positive tags only: a NULL (unknown) source is never served as real (audit F-1, F-4).
          ...(query.realOnly ? { source: { in: [...REAL_PRICE_SOURCES] } } : {}),
        },
        orderBy: { t: 'desc' },
        take: limit,
      });
      return rows.reverse().map((r): Candle => ({ t: r.t.getTime(), o: dec(r.o), h: dec(r.h), l: dec(r.l), c: dec(r.c) }));
    },
    async publishedPools() {
      // Latest published row per pool, read in SQL: one index probe per pool on the
      // (poolId, hour) primary key instead of loading every published row (audit L2).
      const rows = await prisma.$queryRaw<PublishedPoolRow[]>(publishedPoolsSql);
      return rows.map(
        (r): PublishedPool => ({
          symbol: r.symbol,
          feeBps: Number(r.feeBps),
          sizeRounded: dec(r.sizeRounded),
          aprEst: dec(r.aprEst),
          hour: r.hour.getTime(),
        }),
      );
    },
  };
}

export function viemChain(rpcUrl: string, cacheMs = 5000): ChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 3000, retryCount: 0 }) });
  let cached: { at: number; value: bigint | null } | null = null;
  let inflight: Promise<bigint | null> | null = null;
  // eth_chainId: re-checked every 10 minutes once known, every 30 s while the RPC has not answered.
  let chain: { at: number; value: number | null } | null = null;
  let chainInflight: Promise<number | null> | null = null;
  return {
    async chainId() {
      if (chain && Date.now() - chain.at < (chain.value === null ? 30_000 : 600_000)) return chain.value;
      chainInflight ??= client
        .getChainId()
        .catch(() => null)
        .then((value) => {
          chain = { at: Date.now(), value: value ?? chain?.value ?? null };
          chainInflight = null;
          return chain.value;
        });
      return chainInflight;
    },
    async blockNumber() {
      if (cached && Date.now() - cached.at < cacheMs) return cached.value;
      inflight ??= client
        .getBlockNumber({ cacheTime: 0 })
        .catch(() => null)
        .then((value) => {
          cached = { at: Date.now(), value };
          inflight = null;
          return value;
        });
      return inflight;
    },
  };
}
