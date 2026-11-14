import {
  CANDLE_CACHE_SIZE,
  MARKETS,
  POOLS,
  PROTOCOL,
  SPARK_INTERVAL_MS,
  SPARK_POINTS,
  TIMEFRAMES,
  cacheKeys,
  type MarketSnapshot,
  type PriceSource,
} from '@velum/config';
import type { PrismaClient } from '@velum/db';
import { toDecimalString } from '@velum/math';
import type { Redis } from 'ioredis';
import { fromStrings, type WadCandle } from './lib/candles';
import { floatToDec, genCandles, genSpark, seedOpen24h, type Rng } from './lib/demo';
import type { Logger } from './lib/log';
import { markOf } from './lib/snapshot';
import { seriesKey } from './context';

/** Make sure every market and pool row exists and matches packages/config. Returns symbol -> id. */
export async function upsertMarkets(prisma: PrismaClient): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const m of MARKETS) {
    const data = {
      name: m.name,
      status: m.status,
      tokenAddress: m.token?.address ?? null,
      maxLeverage: PROTOCOL.maxLeverage,
      takerFeeBps: PROTOCOL.takerFeeBps,
    };
    const row = await prisma.market.upsert({ where: { symbol: m.symbol }, create: { symbol: m.symbol, ...data }, update: data, select: { id: true } });
    ids.set(m.symbol, row.id);
  }
  for (const p of POOLS) {
    const marketId = ids.get(p.symbol);
    if (!marketId) continue;
    await prisma.pool.upsert({ where: { marketId }, create: { marketId, feeBps: PROTOCOL.spotPoolFeeBps }, update: { feeBps: PROTOCOL.spotPoolFeeBps } });
  }
  return ids;
}

export async function loadSnapshots(redis: Redis): Promise<Map<string, MarketSnapshot>> {
  const raws = await redis.mget(...MARKETS.map((m) => cacheKeys.price(m.symbol)));
  const out = new Map<string, MarketSnapshot>();
  raws.forEach((raw, i) => {
    if (!raw) return;
    try {
      const snap = JSON.parse(raw) as MarketSnapshot;
      if (typeof snap.price === 'string') out.set(MARKETS[i]!.symbol, snap);
    } catch {
      /* ignore corrupt entry; it is rewritten on the next tick */
    }
  });
  return out;
}

/** Last CANDLE_CACHE_SIZE candles per market and timeframe from Postgres. */
export async function loadSeries(prisma: PrismaClient, ids: Map<string, string>): Promise<Map<string, WadCandle[]>> {
  const series = new Map<string, WadCandle[]>();
  await Promise.all(
    [...ids].flatMap(([symbol, marketId]) =>
      TIMEFRAMES.map(async (tf) => {
        const rows = await prisma.candle.findMany({ where: { marketId, tf }, orderBy: { t: 'desc' }, take: CANDLE_CACHE_SIZE });
        series.set(
          seriesKey(symbol, tf),
          rows.reverse().map((r) => fromStrings(r.t.getTime(), r.o.toFixed(), r.h.toFixed(), r.l.toFixed(), r.c.toFixed())),
        );
      }),
    ),
  );
  return series;
}

/**
 * Time of the newest stored PriceTick per market (symbol -> Unix ms), used to seed
 * WorkerContext.lastTickAt on start. Without it, a BullMQ retry of an older candle job delivered after
 * a restart (deploy, crash, max_memory_restart) counted as fresh and moved the close back (audit
 * R2-L1). price-relay stores a tick before it enqueues the tick's candle job, so every pending job is
 * at or before this time: the newest one still applies normally, older retries only extend high/low.
 * One indexed query per market (PriceTick has an index on marketId, at).
 */
export async function loadLastTickAt(prisma: PrismaClient, ids: Map<string, string>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    [...ids].map(async ([symbol, marketId]) => {
      const row = await prisma.priceTick.findFirst({ where: { marketId }, orderBy: { at: 'desc' }, select: { at: true } });
      if (row) out.set(symbol, row.at.getTime());
    }),
  );
  return out;
}

export interface BackfillResult {
  candlesInserted: number;
  snapshotsSeeded: number;
}

/**
 * Demo seeding, safe to run on every start:
 * - candles: only when the Candle table is empty (300 per market and timeframe);
 * - snapshots: only for markets with no snapshot in Redis (60-point spark, seeded 24h open).
 * The first seeding time is recorded under cacheKeys.demoSeeded.
 */
export async function demoBackfill(
  prisma: PrismaClient,
  redis: Redis,
  ids: Map<string, string>,
  snapshots: Map<string, MarketSnapshot>,
  series: Map<string, WadCandle[]>,
  pollMs: number,
  log: Logger,
  now = Date.now(),
  rng: Rng = Math.random,
): Promise<BackfillResult> {
  const result: BackfillResult = { candlesInserted: 0, snapshotsSeeded: 0 };
  const empty = (await prisma.candle.count()) === 0;
  const pipe = redis.pipeline();

  for (const m of MARKETS) {
    const marketId = ids.get(m.symbol);
    if (!marketId) continue;
    const lastClose = series.get(seriesKey(m.symbol, '15m'))?.at(-1)?.c;
    const priceStr = snapshots.get(m.symbol)?.price ?? (lastClose !== undefined ? toDecimalString(lastClose, 2) : m.seedPrice);
    const price = Number(priceStr);

    if (empty) {
      const data = TIMEFRAMES.flatMap((tf) =>
        genCandles(price, m.vol, tf, CANDLE_CACHE_SIZE, now, rng).map((c) => ({
          marketId,
          tf,
          t: new Date(c.t),
          o: floatToDec(c.o),
          h: floatToDec(c.h),
          l: floatToDec(c.l),
          c: floatToDec(c.c),
        })),
      );
      const { count } = await prisma.candle.createMany({ data, skipDuplicates: true });
      result.candlesInserted += count;
    }

    if (!snapshots.has(m.symbol)) {
      const spark = genSpark(price, m.vol, SPARK_POINTS, SPARK_INTERVAL_MS / pollMs, rng).map((x) => floatToDec(x));
      spark[spark.length - 1] = priceStr;
      const snap: MarketSnapshot = {
        symbol: m.symbol,
        price: priceStr,
        mark: markOf(priceStr),
        open24h: floatToDec(seedOpen24h(price, rng)),
        spark,
        source: 'demo',
        updatedAt: now,
      };
      snapshots.set(m.symbol, snap);
      pipe.set(cacheKeys.price(m.symbol), JSON.stringify(snap));
      result.snapshotsSeeded++;
    }
  }

  if (result.snapshotsSeeded || result.candlesInserted) pipe.set(cacheKeys.demoSeeded(), String(now), 'NX');
  await pipe.exec();
  if (result.snapshotsSeeded || result.candlesInserted) log.info('demo data seeded', { ...result });
  return result;
}

/**
 * Never mix simulated and real price history. The decision rests on evidence in Postgres, not on a
 * cache key: every PriceTick is tagged with its source. If the new source is real and demo ticks
 * exist (or the reverse), candles, cached snapshots and the other kind's ticks are removed once;
 * demo backfill then re-seeds if the new source is demo. With no contrary evidence nothing is
 * deleted. Switching between two real sources keeps history.
 */
export async function resetHistoryOnSourceChange(prisma: PrismaClient, redis: Redis, source: PriceSource, log: Logger): Promise<boolean> {
  const real = source !== 'demo';
  const rows = real
    ? await prisma.$queryRaw<Array<{ found: boolean }>>`SELECT EXISTS (SELECT 1 FROM "PriceTick" WHERE "source" = 'demo') AS found`
    : await prisma.$queryRaw<Array<{ found: boolean }>>`SELECT EXISTS (SELECT 1 FROM "PriceTick" WHERE "source" <> 'demo') AS found`;
  await redis.set(cacheKeys.priceSource(), source).catch(() => undefined);
  if (!rows[0]?.found) return false;
  await prisma.$executeRaw`DELETE FROM "Candle"`;
  if (real) await prisma.$executeRaw`DELETE FROM "PriceTick" WHERE "source" = 'demo'`;
  else await prisma.$executeRaw`DELETE FROM "PriceTick" WHERE "source" <> 'demo'`;
  const keys = [...MARKETS.flatMap((m) => [cacheKeys.price(m.symbol), ...TIMEFRAMES.map((tf) => cacheKeys.candles(m.symbol, tf))]), cacheKeys.demoSeeded()];
  await redis.del(...keys);
  log.info('price source changed kind; cleared stored history so real and simulated prices never mix', { source });
  return true;
}
