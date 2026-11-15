import {
  CANDLE_CACHE_SIZE,
  MARKETS,
  MAX_FUTURE_SKEW_MS,
  MAX_SNAPSHOT_BYTES,
  POOLS,
  PROTOCOL,
  SPARK_INTERVAL_MS,
  SPARK_POINTS,
  TIMEFRAMES,
  cacheKeys,
  parseSnapshot,
  type MarketSnapshot,
  type PriceSource,
} from '@velum/config';
import type { CacheMac } from '@velum/config/src/cache-mac';
import { Prisma, type PrismaClient } from '@velum/db';
import { toDecimalString } from '@velum/math';
import type { Redis } from 'ioredis';
import { fromStrings, type WadCandle } from './lib/candles';
import { floatToDec, genCandles, genSpark, seedOpen24h, type Rng } from './lib/demo';
import type { Logger } from './lib/log';
import { markOf } from './lib/snapshot';
import { seriesKey } from './context';
import { tickSourceOf } from './jobs/price-relay';

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

/**
 * Snapshots from Redis, each authenticated (audit F-2) and checked with parseSnapshot (audit M-2): an
 * entry without a valid MAC, or malformed, oversized or future-dated, is ignored (another tenant of a
 * shared Redis can write it) and rewritten on the next tick. A missing snapshot makes the next quote
 * unconfirmed until it changes (audit F-6, lib/snapshot.ts).
 */
export async function loadSnapshots(redis: Redis, mac: CacheMac, now = Date.now()): Promise<Map<string, MarketSnapshot>> {
  const keys = MARKETS.map((m) => cacheKeys.price(m.symbol));
  const raws = await redis.mget(...keys);
  const out = new Map<string, MarketSnapshot>();
  raws.forEach((raw, i) => {
    const symbol = MARKETS[i]!.symbol;
    const snap = parseSnapshot(mac.open(keys[i]!, raw, MAX_SNAPSHOT_BYTES), symbol, now);
    if (snap) out.set(symbol, snap);
  });
  return out;
}

/**
 * Removes candles and price ticks dated ahead of now (audit L-1, M-2): a clock that stepped back or an
 * injected candle job could have written them. Left in place, a future bucket makes every real tick
 * "late" (the chart freezes) and, once its time comes, keeps its bogus open, high and low.
 */
export async function dropFutureHistory(prisma: PrismaClient, log: Logger, now = Date.now()): Promise<number> {
  const cutoff = new Date(now + MAX_FUTURE_SKEW_MS);
  const [candles, ticks] = await Promise.all([prisma.candle.deleteMany({ where: { t: { gt: cutoff } } }), prisma.priceTick.deleteMany({ where: { at: { gt: cutoff } } })]);
  if (candles.count || ticks.count) log.warn('removed history dated in the future', { candles: candles.count, ticks: ticks.count });
  return candles.count + ticks.count;
}

/**
 * Last CANDLE_CACHE_SIZE candles per market and timeframe from Postgres, none dated ahead of now. A real
 * source reads only candles tagged with it (audit I-7); a candle of unknown source (NULL, audit F-1) is
 * never shown as real. The demo source also reads unknown candles: on testnet everything is simulated
 * and the API serves those rows from Postgres anyway, so the chart and the cache agree.
 */
export async function loadSeries(prisma: PrismaClient, ids: Map<string, string>, source: PriceSource, now = Date.now()): Promise<Map<string, WadCandle[]>> {
  const series = new Map<string, WadCandle[]>();
  const until = new Date(now + MAX_FUTURE_SKEW_MS);
  const bySource: Prisma.CandleWhereInput = source === 'demo' ? { OR: [{ source }, { source: null }] } : { source };
  await Promise.all(
    [...ids].flatMap(([symbol, marketId]) =>
      TIMEFRAMES.map(async (tf) => {
        const rows = await prisma.candle.findMany({ where: { marketId, tf, t: { lte: until }, ...bySource }, orderBy: { t: 'desc' }, take: CANDLE_CACHE_SIZE });
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
export async function loadLastTickAt(prisma: PrismaClient, ids: Map<string, string>, now = Date.now()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const until = new Date(now + MAX_FUTURE_SKEW_MS);
  await Promise.all(
    [...ids].map(async ([symbol, marketId]) => {
      // A tick dated ahead (clock stepped back) would make every new tick "late" (audit L-1).
      const row = await prisma.priceTick.findFirst({ where: { marketId, at: { lte: until } }, orderBy: { at: 'desc' }, select: { at: true } });
      if (row) out.set(symbol, row.at.getTime());
    }),
  );
  return out;
}

/**
 * Price of the newest stored PriceTick of `source` per market (symbol -> decimal string), none dated
 * ahead of now. price-relay checks a market's first quote against it when the market has no snapshot
 * (audit F-6): after a lost or rejected snapshot the first quote would otherwise pass the jump guard
 * unchecked. One indexed query per market.
 */
export async function loadLastTickPrices(prisma: PrismaClient, ids: Map<string, string>, source: PriceSource, now = Date.now()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const until = new Date(now + MAX_FUTURE_SKEW_MS);
  await Promise.all(
    [...ids].map(async ([symbol, marketId]) => {
      const row = await prisma.priceTick.findFirst({ where: { marketId, source: tickSourceOf(source), at: { lte: until } }, orderBy: { at: 'desc' }, select: { price: true } });
      if (row) out.set(symbol, row.price.toFixed());
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
 * - candles: only when there are no demo candles and no candles of unknown source (300 per market and
 *   timeframe; existing buckets are kept);
 * - snapshots: only for markets with no (authenticated) snapshot in Redis (60-point spark, seeded 24h
 *   open).
 * The first seeding time is recorded under cacheKeys.demoSeeded.
 */
export async function demoBackfill(
  prisma: PrismaClient,
  redis: Redis,
  mac: CacheMac,
  ids: Map<string, string>,
  snapshots: Map<string, MarketSnapshot>,
  series: Map<string, WadCandle[]>,
  pollMs: number,
  log: Logger,
  now = Date.now(),
  rng: Rng = Math.random,
): Promise<BackfillResult> {
  const result: BackfillResult = { candlesInserted: 0, snapshotsSeeded: 0 };
  const empty = (await prisma.candle.count({ where: { OR: [{ source: 'demo' }, { source: null }] } })) === 0;
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
          source: 'demo',
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
        checkedAt: now,
      };
      snapshots.set(m.symbol, snap);
      pipe.set(cacheKeys.price(m.symbol), mac.seal(cacheKeys.price(m.symbol), JSON.stringify(snap)));
      result.snapshotsSeeded++;
    }
  }

  if (result.snapshotsSeeded || result.candlesInserted) pipe.set(cacheKeys.demoSeeded(), String(now), 'NX');
  await pipe.exec();
  if (result.snapshotsSeeded || result.candlesInserted) log.info('demo data seeded', { ...result });
  return result;
}

/**
 * Never mix simulated and real price history. The decision rests on positive evidence in Postgres, not
 * on a cache key: a PriceTick of the other kind of source, or a Candle tagged with the other kind (audit
 * I-7). A candle of unknown source (NULL: written before the column existed, or by a release that does
 * not know it, audit F-1) is never evidence. With evidence, candles, cached snapshots and the other
 * kind's ticks are removed once; demo backfill then re-seeds if the new source is demo. Without it
 * nothing is deleted. Switching between two real sources keeps history.
 */
export async function resetHistoryOnSourceChange(prisma: PrismaClient, redis: Redis, source: PriceSource, log: Logger): Promise<boolean> {
  const real = source !== 'demo';
  const rows = real
    ? await prisma.$queryRaw<Array<{ found: boolean }>>`SELECT (EXISTS (SELECT 1 FROM "PriceTick" WHERE "source" = 'demo') OR EXISTS (SELECT 1 FROM "Candle" WHERE "source" = 'demo')) AS found`
    : await prisma.$queryRaw<Array<{ found: boolean }>>`SELECT (EXISTS (SELECT 1 FROM "PriceTick" WHERE "source" <> 'demo') OR EXISTS (SELECT 1 FROM "Candle" WHERE "source" IN ('robinhood', 'chainlink'))) AS found`;
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

/**
 * Tags candles of unknown source (NULL, audit F-1, F-4) whose stored ticks prove where they came from.
 * A bucket [t, t + timeframe) of a market is proven to come from source S when every PriceTick of that
 * market inside it is of kind S ("oracle" ticks are Chainlink), its open and close are prices of ticks
 * inside it, and its high and low are the highest and lowest of those prices: the candle was built from
 * exactly these ticks. A candle seeded without ticks (demo backfill), one whose ticks were pruned, or one
 * that mixes a seeded open with later ticks stays unknown: kept, never shown as real on mainnet, never
 * evidence of a source change. Only candles ending after the market's oldest stored tick are examined
 * (older ones can never be proven: ticks are only ever pruned).
 */
export const retagUnknownCandlesSql = (marketId: string, since: Date | null) => Prisma.sql`
  WITH oldest AS (
    SELECT m."id" AS "marketId",
           (SELECT p."at" FROM "PriceTick" p WHERE p."marketId" = m."id" ORDER BY p."at" ASC LIMIT 1) AS "at0"
    FROM "Market" m
    WHERE m."id" = ${marketId}
  ),
  unknown AS (
    SELECT c."marketId", c."tf", c."t", c."o", c."c", c."t" + w."span" AS "tEnd"
    FROM "Candle" c
    JOIN (VALUES ('15m', interval '15 minutes'), ('1h', interval '1 hour'), ('4h', interval '4 hours'), ('1D', interval '1 day')) AS w("tf", "span") ON w."tf" = c."tf"
    JOIN oldest o ON o."marketId" = c."marketId"
    WHERE c."source" IS NULL AND o."at0" IS NOT NULL AND c."t" + w."span" > o."at0"
      ${since ? Prisma.sql`AND c."t" + w."span" > ${since}` : Prisma.empty}
  ),
  -- Per candle, its own tick range through the ("marketId", "at") index (final deploy audit N-1): a plain
  -- join let the planner pair every candle with every tick of its market (time grew with the square of
  -- the stored history: 66 s for 3 days of ticks, minutes for 7), which kept the workers in start-up past
  -- deploy.sh's 60 s heartbeat wait.
  proof AS (
    SELECT u."marketId", u."tf", u."t", s."kind", s."kinds", s."hasOpen", s."hasClose", s."hi", s."lo"
    FROM unknown u
    CROSS JOIN LATERAL (
      SELECT min(k."kind") AS "kind",
             count(DISTINCT k."kind") AS "kinds",
             bool_or(p."price" = u."o") AS "hasOpen",
             bool_or(p."price" = u."c") AS "hasClose",
             max(p."price") AS "hi",
             min(p."price") AS "lo",
             count(*) AS "n"
      FROM "PriceTick" p
      CROSS JOIN LATERAL (SELECT CASE p."source" WHEN 'oracle' THEN 'chainlink' ELSE p."source" END AS "kind") k
      WHERE p."marketId" = u."marketId" AND p."at" >= u."t" AND p."at" < u."tEnd"
    ) s
    WHERE s."n" > 0
  )
  UPDATE "Candle" c SET "source" = proof."kind"
  FROM proof
  WHERE c."marketId" = proof."marketId" AND c."tf" = proof."tf" AND c."t" = proof."t"
    AND c."source" IS NULL
    AND proof."kinds" = 1 AND proof."kind" IN ('demo', 'robinhood', 'chainlink')
    AND proof."hasOpen" AND proof."hasClose" AND proof."hi" = c."h" AND proof."lo" = c."l"`;

export interface RetagOptions {
  /** Only candles whose bucket ends after this time (start-up tags the recent ones, the rest follows). */
  since?: Date;
  /** Statement timeout per market (default 120 s). A market that runs out keeps its candles unknown. */
  timeoutMs?: number;
  /** Total time for all markets; once spent, the remaining markets are left for a later run. */
  budgetMs?: number;
}

/**
 * Runs retagUnknownCandlesSql market by market, each in its own transaction with a statement timeout, so
 * one large history can neither hold the workers' start-up past deploy.sh's heartbeat wait nor leave a
 * runaway query behind (final deploy audit N-1). A market that fails or times out keeps its candles
 * unknown (never shown as real on mainnet) and is tried again on the next run. Returns how many candles
 * were tagged.
 */
export async function retagUnknownCandles(prisma: PrismaClient, log: Logger, opts: RetagOptions = {}): Promise<number> {
  const timeoutMs = Math.max(1000, Math.floor(opts.timeoutMs ?? 120_000));
  const deadline = opts.budgetMs === undefined ? Infinity : Date.now() + opts.budgetMs;
  const markets = await prisma.market.findMany({ select: { id: true, symbol: true } });
  let tagged = 0;
  for (const m of markets) {
    const left = Math.min(timeoutMs, deadline - Date.now());
    if (left < 1000) {
      log.info('candle tagging time budget spent; the remaining markets are tagged later', { market: m.symbol });
      break;
    }
    try {
      tagged += await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(Math.floor(left))}, true)`;
          return tx.$executeRaw(retagUnknownCandlesSql(m.id, opts.since ?? null));
        },
        { timeout: Math.floor(left) + 10_000, maxWait: 10_000 },
      );
    } catch (err) {
      log.warn('could not tag candles of unknown source for a market; they stay unknown and are tried again later', {
        market: m.symbol,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (tagged) log.info('tagged candles of unknown source from their stored ticks', { candles: tagged, since: opts.since?.toISOString() ?? 'all' });
  return tagged;
}

/**
 * The stored-history steps of every start, in order (index.ts): reset only on positive evidence of the
 * other kind of source (resetHistoryOnSourceChange), drop rows dated ahead (dropFutureHistory), then tag
 * the candles an older release wrote without a source where their ticks prove it (retagUnknownCandles).
 */
export async function prepareHistory(
  prisma: PrismaClient,
  redis: Redis,
  source: PriceSource,
  log: Logger,
  retag: RetagOptions = {},
): Promise<{ reset: boolean; tagged: number }> {
  const reset = await resetHistoryOnSourceChange(prisma, redis, source, log);
  await dropFutureHistory(prisma, log);
  const tagged = await retagUnknownCandles(prisma, log, retag);
  return { reset, tagged };
}
