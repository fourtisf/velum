import { DEMO, SPARK_INTERVAL_MS, SPARK_POINTS, type MarketSnapshot, type PriceSource } from '@velum/config';
import { WAD, bps, parseWad, roundTo, toDecimalString, wmul } from '@velum/math';

/** Mark price = index price plus the demo mark premium, 2 decimals, rounded down. */
export function markOf(price: string): string {
  const p = parseWad(price) ?? 0n;
  return toDecimalString(roundTo(wmul(p, WAD + bps(DEMO.markPremiumBps), 'floor'), 2, 'floor'), 2);
}

/**
 * Next snapshot for a market. The sparkline keeps one point per minute (SPARK_POINTS max);
 * within the same minute the last point tracks the live price.
 */
export function buildSnapshot(
  prev: MarketSnapshot | undefined,
  symbol: string,
  price: string,
  open24h: string,
  source: PriceSource,
  now: number,
): MarketSnapshot {
  let spark = prev?.spark ? [...prev.spark] : [];
  const prevMinute = prev ? Math.floor(prev.updatedAt / SPARK_INTERVAL_MS) : -1;
  const minute = Math.floor(now / SPARK_INTERVAL_MS);
  if (!spark.length || minute > prevMinute) spark.push(price);
  else spark[spark.length - 1] = price;
  if (spark.length > SPARK_POINTS) spark = spark.slice(-SPARK_POINTS);
  return { symbol, price, mark: markOf(price), open24h, spark, source, updatedAt: now };
}
