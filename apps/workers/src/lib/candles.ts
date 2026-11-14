import { CANDLE_CACHE_SIZE, TIMEFRAME_MS, type Candle, type Timeframe } from '@velum/config';
import { Prisma } from '@velum/db';
import { parseWad, toDecimalString, wmax, wmin, type Wad } from '@velum/math';

/** Start of the UTC-aligned bucket that contains `t`. */
export function bucketStart(t: number, tf: Timeframe): number {
  const ms = TIMEFRAME_MS[tf];
  return Math.floor(t / ms) * ms;
}

export interface WadCandle {
  t: number;
  o: Wad;
  h: Wad;
  l: Wad;
  c: Wad;
}

/**
 * Apply one price tick to an in-memory series (oldest first). Updates the current bucket or
 * opens a new one, keeping at most `max` candles. Late ticks for older buckets are ignored.
 * Returns true when the series changed.
 */
export function applyTick(series: WadCandle[], t: number, price: Wad, max = CANDLE_CACHE_SIZE): boolean {
  const last = series[series.length - 1];
  if (last && last.t === t) {
    last.h = wmax(last.h, price);
    last.l = wmin(last.l, price);
    last.c = price;
    return true;
  }
  if (last && t < last.t) return false;
  series.push({ t, o: price, h: price, l: price, c: price });
  if (series.length > max) series.splice(0, series.length - max);
  return true;
}

export const toCandle = (c: WadCandle): Candle => ({
  t: c.t,
  o: toDecimalString(c.o),
  h: toDecimalString(c.h),
  l: toDecimalString(c.l),
  c: toDecimalString(c.c),
});

export function fromStrings(t: number, o: string, h: string, l: string, c: string): WadCandle {
  return { t, o: parseWad(o) ?? 0n, h: parseWad(h) ?? 0n, l: parseWad(l) ?? 0n, c: parseWad(c) ?? 0n };
}

/** Candle.t is timestamp(3) holding UTC (Prisma's convention); cast explicitly so session TimeZone never shifts it. */
const utcTimestamp = (t: number): string => new Date(t).toISOString().slice(0, -1);

export interface CandleUpsert {
  marketId: string;
  tf: Timeframe;
  t: number;
  price: string;
}

/**
 * One INSERT … ON CONFLICT for many buckets. New buckets open at the tick price; existing
 * buckets keep their open and extend high/low, close follows the tick. Values are parameters.
 */
export function candleUpsertSql(rows: CandleUpsert[]): Prisma.Sql {
  const values = rows.map(
    (r) =>
      Prisma.sql`(${r.marketId}, ${r.tf}, CAST(${utcTimestamp(r.t)} AS TIMESTAMP(3)), CAST(${r.price} AS DECIMAL(38,12)), CAST(${r.price} AS DECIMAL(38,12)), CAST(${r.price} AS DECIMAL(38,12)), CAST(${r.price} AS DECIMAL(38,12)))`,
  );
  return Prisma.sql`
    INSERT INTO "Candle" ("marketId", "tf", "t", "o", "h", "l", "c")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("marketId", "tf", "t") DO UPDATE SET
      "h" = GREATEST("Candle"."h", EXCLUDED."h"),
      "l" = LEAST("Candle"."l", EXCLUDED."l"),
      "c" = EXCLUDED."c"`;
}
