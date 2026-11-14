/** Production implementations of the readers in deps.ts (Redis, Prisma, viem). */
import { cacheKeys, type Candle, type MarketSnapshot, type Timeframe } from '@velum/config';
import type { PrismaClient } from '@velum/db';
import type { Redis } from 'ioredis';
import { createPublicClient, http } from 'viem';
import type { CacheReader, ChainReader, DbReader, PublishedPool } from './deps';

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function redisCache(redis: Redis): CacheReader {
  return {
    async ping() {
      try {
        return (await withTimeout(redis.ping(), 1500, 'TIMEOUT')) === 'PONG';
      } catch {
        return false;
      }
    },
    async snapshots(symbols) {
      const out = new Map<string, MarketSnapshot>();
      if (!symbols.length) return out;
      const raws = await redis.mget(...symbols.map((s) => cacheKeys.price(s)));
      raws.forEach((raw, i) => {
        const snap = parseJson<MarketSnapshot>(raw);
        if (snap && typeof snap.price === 'string') out.set(symbols[i]!, snap);
      });
      return out;
    },
    async candles(symbol, tf) {
      const arr = parseJson<Candle[]>(await redis.get(cacheKeys.candles(symbol, tf)));
      return Array.isArray(arr) ? arr : null;
    },
    async heartbeat(worker) {
      const raw = await redis.get(cacheKeys.heartbeat(worker));
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) ? n : null;
    },
  };
}

/** Prisma Decimal to a plain decimal string (no exponent notation). */
const dec = (d: { toFixed(): string }): string => d.toFixed();

export function prismaDb(prisma: PrismaClient): DbReader {
  return {
    async ping() {
      const query = prisma.$queryRaw`SELECT 1`.then(
        () => true,
        () => false,
      );
      return withTimeout(query, 2000, false);
    },
    async candles(symbol, tf: Timeframe, limit) {
      const rows = await prisma.candle.findMany({
        where: { tf, market: { symbol } },
        orderBy: { t: 'desc' },
        take: limit,
      });
      return rows.reverse().map((r): Candle => ({ t: r.t.getTime(), o: dec(r.o), h: dec(r.h), l: dec(r.l), c: dec(r.c) }));
    },
    async publishedPools() {
      const rows = await prisma.poolHourly.findMany({
        where: { published: true },
        orderBy: { hour: 'desc' },
        distinct: ['poolId'],
        include: { pool: { include: { market: true } } },
      });
      return rows.map(
        (r): PublishedPool => ({
          symbol: r.pool.market.symbol,
          feeBps: r.pool.feeBps,
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
  return {
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
