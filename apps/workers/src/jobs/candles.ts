import { CANDLE_CACHE_SIZE, TIMEFRAMES, cacheKeys, type Timeframe } from '@velum/config';
import { parseWad } from '@velum/math';
import type { Redis } from 'ioredis';
import { applyTick, bucketStart, candleUpsertSql, toCandle, type CandleUpsert, type WadCandle } from '../lib/candles';
import { CANDLES_WORKER, seriesKey, type CandleJobData, type WorkerContext } from '../context';

/** Write the cached series for the given keys (all when omitted) to Redis. */
export async function writeCandleCaches(redis: Redis, series: Map<string, WadCandle[]>, keys?: Iterable<string>): Promise<void> {
  const pipe = redis.pipeline();
  for (const key of keys ?? series.keys()) {
    const s = series.get(key);
    if (!s) continue;
    const [symbol, tf] = key.split(':') as [string, Timeframe];
    pipe.set(cacheKeys.candles(symbol, tf), JSON.stringify(s.map(toCandle)));
  }
  await pipe.exec();
}

/** BullMQ options for candle jobs: a failed Postgres write is retried with backoff (audit L9). */
export const CANDLE_JOB_OPTIONS = { attempts: 5, backoff: { type: 'exponential', delay: 1000 } } as const;

/** Copy of a series that applyTick may change without touching the original (it only edits the last candle or appends). */
function draftOf(series: WadCandle[] | undefined): WadCandle[] {
  const draft = series ? series.slice() : [];
  const i = draft.length - 1;
  if (i >= 0) draft[i] = { ...draft[i]! };
  return draft;
}

/**
 * Fold one tick into every timeframe. Postgres is the source of truth: the tick is applied to
 * drafts, written to Postgres, and only then committed to memory and the Redis cache, so a failed
 * write leaves both untouched and the job can be retried (audit L9). A retried tick older than one
 * already applied for that market only extends high/low; it never moves the close backwards.
 */
export async function runCandles(ctx: WorkerContext, data: CandleJobData): Promise<number> {
  const fresh: CandleUpsert[] = [];
  const late: CandleUpsert[] = [];
  const drafts = new Map<string, WadCandle[]>();
  const advanced: string[] = [];
  for (const [symbol, price] of Object.entries(data.prices)) {
    const marketId = ctx.marketIds.get(symbol);
    const w = parseWad(price);
    if (!marketId || w === null || w <= 0n) continue;
    const isLate = data.at < (ctx.lastTickAt.get(symbol) ?? -Infinity);
    for (const tf of TIMEFRAMES) {
      const t = bucketStart(data.at, tf);
      const key = seriesKey(symbol, tf);
      const draft = drafts.get(key) ?? draftOf(ctx.series.get(key));
      if (applyTick(draft, t, w, CANDLE_CACHE_SIZE, isLate)) {
        (isLate ? late : fresh).push({ marketId, tf, t, price });
        drafts.set(key, draft);
      }
    }
    if (!isLate) advanced.push(symbol);
  }

  const writes = [...(fresh.length ? [candleUpsertSql(fresh)] : []), ...(late.length ? [candleUpsertSql(late, { keepClose: true })] : [])];
  if (writes.length === 1) await ctx.prisma.$executeRaw(writes[0]!);
  else if (writes.length > 1) await ctx.prisma.$transaction(writes.map((q) => ctx.prisma.$executeRaw(q)));

  // Committed in Postgres: now (and only now) update memory and the cache.
  for (const [key, s] of drafts) ctx.series.set(key, s);
  for (const symbol of advanced) ctx.lastTickAt.set(symbol, Math.max(data.at, ctx.lastTickAt.get(symbol) ?? -Infinity));
  await writeCandleCaches(ctx.redis, ctx.series, drafts.keys());
  await ctx.redis.set(cacheKeys.heartbeat(CANDLES_WORKER), String(Date.now()));
  return fresh.length + late.length;
}
