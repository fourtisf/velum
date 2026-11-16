import { Prisma, type PrismaClient } from '@velum/db';
import type { Logger } from '../lib/log';

/** Buckets that end later than this before now are left to the live candles job (they may still change). */
export const REBUILD_OPEN_MARGIN_MS = 2 * 60_000;
const DAY_MS = 86_400_000;
/** CAST so the session time zone never shifts a time (timestamp(3) columns hold UTC). */
const ts = (t: number) => Prisma.sql`CAST(${new Date(t).toISOString().slice(0, -1)} AS TIMESTAMP(3))`;

/**
 * Rebuilds candles of unknown source (NULL) from the stored ticks of their bucket, for one market and one UTC day
 * [from, from + 1 day) (every timeframe's buckets align to UTC midnight, so a day holds whole buckets of all four).
 *
 * The candle builders before the source column (and before late-tick and retry handling) did not always fold every
 * tick into every bucket (a lost or failed candle job, a reordered retry, a restart), so their candles rarely match
 * the stored ticks exactly and the proof in retagUnknownCandlesSql leaves them unknown: on mainnet the real history
 * was hidden. Here the candle is recomputed from the ticks themselves, exactly (decimal columns, no floats): open =
 * first tick, close = last tick (time, then insertion order), high/low = extremes, tagged with the ticks' source.
 *
 * Only a bucket whose ticks are all of one real kind (robinhood, or oracle = chainlink) is written; a bucket with a
 * demo tick, mixed kinds or no ticks is left exactly as it is (audit F-4: a demo-seeded candle never becomes real).
 * Only buckets that start at or after the market's oldest stored tick (`at0`, so none of their ticks were pruned)
 * and that ended before `cutoff` (closed). Existing rows are replaced only while their source is NULL: tagged
 * candles (the live builder's, or demo) are never touched. Running it again changes nothing (idempotent).
 */
export const rebuildFromTicksSql = (marketId: string, from: Date, at0: Date, cutoff: Date) => Prisma.sql`
  WITH w("tf", "secs") AS (VALUES ('15m', 900), ('1h', 3600), ('4h', 14400), ('1D', 86400)),
  ticks AS (
    SELECT p."at", p."id", p."price", CASE p."source" WHEN 'oracle' THEN 'chainlink' ELSE p."source" END AS "kind"
    FROM "PriceTick" p
    WHERE p."marketId" = ${marketId} AND p."at" >= ${ts(from.getTime())} AND p."at" < ${ts(from.getTime() + DAY_MS)}
  ),
  agg AS (
    SELECT w."tf", w."secs",
           TIMESTAMP '1970-01-01' + floor(extract(epoch FROM t."at") / w."secs") * w."secs" * interval '1 second' AS "bt",
           (array_agg(t."price" ORDER BY t."at", t."id"))[1] AS "o",
           max(t."price") AS "h",
           min(t."price") AS "l",
           (array_agg(t."price" ORDER BY t."at" DESC, t."id" DESC))[1] AS "c",
           count(DISTINCT t."kind") AS "kinds",
           min(t."kind") AS "kind"
    FROM ticks t CROSS JOIN w
    GROUP BY w."tf", w."secs", 3
  )
  INSERT INTO "Candle" ("marketId", "tf", "t", "o", "h", "l", "c", "source")
  SELECT ${marketId}, a."tf", a."bt", a."o", a."h", a."l", a."c", a."kind"
  FROM agg a
  WHERE a."kinds" = 1 AND a."kind" IN ('robinhood', 'chainlink')
    AND a."bt" >= ${ts(at0.getTime())}
    AND a."bt" + a."secs" * interval '1 second' <= ${ts(cutoff.getTime())}
  ON CONFLICT ("marketId", "tf", "t") DO UPDATE SET
    "o" = EXCLUDED."o", "h" = EXCLUDED."h", "l" = EXCLUDED."l", "c" = EXCLUDED."c", "source" = EXCLUDED."source"
  WHERE "Candle"."source" IS NULL`;

export interface RebuildOptions {
  /** Statement timeout per market and day (default 30 s). */
  timeoutMs?: number;
  /** Total time; once spent the rest waits for the next run (default 5 minutes). */
  budgetMs?: number;
  now?: number;
  /** Only these Market ids (tests); all markets when omitted. */
  marketIds?: string[];
  /** Market-day keys already rebuilt by this process (the caller keeps the set between runs). */
  done?: Set<string>;
}

/**
 * Runs rebuildFromTicksSql for every market, day by day from its oldest stored tick, each statement in its own
 * transaction with a statement timeout and the whole run within a time budget (the N-1 pattern of
 * retagUnknownCandles): never in the start-up path. A day that fails keeps its candles as they are and is tried
 * again on the next run. Returns how many candles were written.
 */
export async function rebuildCandlesFromTicks(prisma: PrismaClient, log: Logger, opts: RebuildOptions = {}): Promise<number> {
  const timeoutMs = Math.max(1000, Math.floor(opts.timeoutMs ?? 30_000));
  const deadline = Date.now() + (opts.budgetMs ?? 300_000);
  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - REBUILD_OPEN_MARGIN_MS);
  const markets = await prisma.market.findMany({ where: opts.marketIds ? { id: { in: opts.marketIds } } : {}, select: { id: true, symbol: true } });
  let written = 0;
  for (const m of markets) {
    // Real ticks only start the range: a market whose ticks are all demo has nothing to rebuild.
    const first = await prisma.priceTick.findFirst({ where: { marketId: m.id }, orderBy: { at: 'asc' }, select: { at: true } });
    const hasReal = await prisma.priceTick.findFirst({ where: { marketId: m.id, source: { in: ['robinhood', 'oracle'] } }, select: { at: true } });
    if (!first || !hasReal) continue;
    // Every UTC day from the oldest stored tick: a bucket may hold an unknown candle, or none at all (a reset that
    // deleted the candles kept the real ticks, audit F-4). Days already done in this process are skipped.
    const startDay = Math.floor(first.at.getTime() / DAY_MS) * DAY_MS;
    for (let day = startDay; day < cutoff.getTime(); day += DAY_MS) {
      const left = Math.min(timeoutMs, deadline - Date.now());
      if (left < 1000) {
        log.info('candle rebuild time budget spent; the rest is rebuilt on the next run', { market: m.symbol, day: new Date(day).toISOString().slice(0, 10) });
        if (written) log.info('rebuilt candles of unknown source from their stored ticks', { candles: written });
        return written;
      }
      try {
        if (opts.done?.has(`${m.id}:${day}`)) continue;
        written += await prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(Math.floor(left))}, true)`;
            return tx.$executeRaw(rebuildFromTicksSql(m.id, new Date(day), first.at, cutoff));
          },
          { timeout: Math.floor(left) + 10_000, maxWait: 10_000 },
        );
        // A day whose buckets have all closed never changes again (ticks are only appended now and pruned later).
        if (day + DAY_MS <= cutoff.getTime()) opts.done?.add(`${m.id}:${day}`);
      } catch (err) {
        log.warn('could not rebuild candles from ticks for a market and day; they stay as they are and are tried again later', {
          market: m.symbol,
          day: new Date(day).toISOString().slice(0, 10),
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  if (written) log.info('rebuilt candles of unknown source from their stored ticks', { candles: written });
  return written;
}
