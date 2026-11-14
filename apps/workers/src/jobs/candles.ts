import { TIMEFRAMES, cacheKeys, type Timeframe } from '@velum/config';
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

/** Fold one tick into every timeframe: Postgres first (source of truth), then the Redis cache. */
export async function runCandles(ctx: WorkerContext, data: CandleJobData): Promise<number> {
  const rows: CandleUpsert[] = [];
  const changed = new Set<string>();
  for (const [symbol, price] of Object.entries(data.prices)) {
    const marketId = ctx.marketIds.get(symbol);
    const w = parseWad(price);
    if (!marketId || w === null || w <= 0n) continue;
    for (const tf of TIMEFRAMES) {
      const t = bucketStart(data.at, tf);
      const key = seriesKey(symbol, tf);
      let s = ctx.series.get(key);
      if (!s) ctx.series.set(key, (s = []));
      if (applyTick(s, t, w)) {
        rows.push({ marketId, tf, t, price });
        changed.add(key);
      }
    }
  }
  if (rows.length) await ctx.prisma.$executeRaw(candleUpsertSql(rows));
  await writeCandleCaches(ctx.redis, ctx.series, changed);
  await ctx.redis.set(cacheKeys.heartbeat(CANDLES_WORKER), String(Date.now()));
  return rows.length;
}
