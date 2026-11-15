import { CANDLE_CACHE_SIZE, MAX_FUTURE_SKEW_MS, TIMEFRAMES, cacheKeys, isPriceString, type Timeframe } from '@velum/config';
import { parseWad } from '@velum/math';
import type { Redis } from 'ioredis';
import { applyTick, bucketStart, candleUpsertSql, toCandle, type CandleUpsert, type WadCandle } from '../lib/candles';
import { CANDLES_WORKER, seriesKey, type CandleJobData, type WorkerContext } from '../context';
import { tickSourceOf } from './price-relay';

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
/** A queued candle job older than this is dropped (retries finish within about 30 s). */
export const CANDLE_JOB_MAX_AGE_MS = 3_600_000;

/**
 * The tick a queued candle job names, read back from PriceTick (audit M-2). Velum's Redis may be shared
 * with other tenants, so a job's payload is never trusted: only its `at` is read, it must lie within
 * [now - CANDLE_JOB_MAX_AGE_MS, now + MAX_FUTURE_SKEW_MS], and the prices come from the ticks
 * price-relay stored in Postgres at exactly that time (before it queued the job) for the current
 * source. A forged job can at most make the worker fold an existing tick in again, which changes nothing.
 * Returns null (the job is dropped) when the job is malformed, out of the window or names no ticks.
 */
export async function candleJobFromTicks(ctx: WorkerContext, job: unknown, now = Date.now()): Promise<CandleJobData | null> {
  const at = (job as { at?: unknown } | null)?.at;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < now - CANDLE_JOB_MAX_AGE_MS || at > now + MAX_FUTURE_SKEW_MS) {
    ctx.log.warn('candle job rejected: no valid tick time', { at: typeof at === 'number' ? at : String(at) });
    return null;
  }
  const bySymbol = new Map([...ctx.marketIds].map(([symbol, id]) => [id, symbol]));
  const rows = await ctx.prisma.priceTick.findMany({
    where: { at: new Date(at), marketId: { in: [...bySymbol.keys()] }, source: tickSourceOf(ctx.source.name) },
    select: { marketId: true, price: true },
  });
  const prices: Record<string, string> = {};
  for (const r of rows) {
    const symbol = bySymbol.get(r.marketId);
    const price = r.price.toFixed();
    if (symbol && isPriceString(price)) prices[symbol] = price;
  }
  if (!Object.keys(prices).length) {
    ctx.log.warn('candle job rejected: no stored tick at that time', { at });
    return null;
  }
  return { at, prices };
}

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
 * A tick dated ahead of `now` (beyond the clock skew allowance) is ignored (audit L-1): it would open a
 * future bucket that every later tick counts as "late", freezing the chart. Prices must be positive
 * decimals below 1e9, like every source enforces.
 */
export async function runCandles(ctx: WorkerContext, data: CandleJobData, now = Date.now()): Promise<number> {
  if (!Number.isSafeInteger(data.at) || data.at > now + MAX_FUTURE_SKEW_MS) {
    ctx.log.warn('candle tick ignored: dated in the future', { at: data.at, now });
    return 0;
  }
  const fresh: CandleUpsert[] = [];
  const late: CandleUpsert[] = [];
  const drafts = new Map<string, WadCandle[]>();
  const advanced: string[] = [];
  for (const [symbol, price] of Object.entries(data.prices)) {
    const marketId = ctx.marketIds.get(symbol);
    const w = isPriceString(price) ? parseWad(price) : null;
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

  const source = ctx.source.name;
  const writes = [...(fresh.length ? [candleUpsertSql(fresh, { source })] : []), ...(late.length ? [candleUpsertSql(late, { source, keepClose: true })] : [])];
  if (writes.length === 1) await ctx.prisma.$executeRaw(writes[0]!);
  else if (writes.length > 1) await ctx.prisma.$transaction(writes.map((q) => ctx.prisma.$executeRaw(q)));

  // Committed in Postgres: now (and only now) update memory and the cache.
  for (const [key, s] of drafts) ctx.series.set(key, s);
  for (const symbol of advanced) ctx.lastTickAt.set(symbol, Math.max(data.at, ctx.lastTickAt.get(symbol) ?? -Infinity));
  await writeCandleCaches(ctx.redis, ctx.series, drafts.keys());
  await ctx.redis.set(cacheKeys.heartbeat(CANDLES_WORKER), String(Date.now()));
  return fresh.length + late.length;
}
