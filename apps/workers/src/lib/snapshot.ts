import { DEMO, SPARK_INTERVAL_MS, SPARK_POINTS, type MarketSnapshot, type PriceSource } from '@velum/config';
import { WAD, bps, parseWad, roundTo, toDecimalString, wmul } from '@velum/math';

/** Mark price = index price plus the demo mark premium, 2 decimals, rounded down. */
export function markOf(price: string): string {
  const p = parseWad(price) ?? 0n;
  return toDecimalString(roundTo(wmul(p, WAD + bps(DEMO.markPremiumBps), 'floor'), 2, 'floor'), 2);
}

/** A quote time reported by the source itself (a Chainlink round's updatedAt), in Unix ms. */
const validSourceTime = (t: number | undefined): t is number => t !== undefined && Number.isSafeInteger(t) && t > 0;

/**
 * Quote time for a new reading (audit M-1). Upstream response times (Robinhood's generatedAt) advance
 * while a closed market's bid/ask stays frozen for days, so they say nothing about the quote. A source
 * that dates its quotes (a Chainlink round) is used as is; demo ticks are always new; otherwise the
 * quote keeps the previous snapshot's time while the price is unchanged, and is `now` when it moved.
 * The previous snapshot comes from Redis on start, so a restart does not make a frozen quote look new;
 * without one, the reading is unconfirmed (see quoteConfirmed).
 */
export function quoteTime(prev: MarketSnapshot | undefined, price: string, source: PriceSource, now: number, sourceTime?: number): number {
  if (source === 'demo') return now;
  if (validSourceTime(sourceTime)) return Math.min(sourceTime, now);
  if (prev && prev.source === source && prev.price === price && prev.updatedAt <= now) return prev.updatedAt;
  return now;
}

/**
 * Whether the quote time of a new reading is known (audit F-6). Without a previous snapshot of the same
 * source (Redis lost it, a co-tenant replaced it, or it predates authenticated values) quoteTime can only
 * say "now", which would make a frozen quote look live for QUOTE_FROZEN_AFTER_MS. Such a quote stays
 * unconfirmed (not live) until price-relay sees it change. Demo prices and quotes the source dates itself
 * (a Chainlink round) are always confirmed.
 */
export function quoteConfirmed(prev: MarketSnapshot | undefined, price: string, source: PriceSource, sourceTime?: number): boolean {
  if (source === 'demo' || validSourceTime(sourceTime)) return true;
  if (!prev || prev.source !== source) return false;
  return prev.price !== price || !prev.unconfirmed;
}

/**
 * Next snapshot for a market, stamped with the quote time (`quoteAt`, see quoteTime) in updatedAt and
 * the time of this reading in checkedAt, and marked unconfirmed when `confirmed` is false (see
 * quoteConfirmed). The sparkline keeps one point per minute of readings (SPARK_POINTS max); within the
 * same minute the last point tracks the live price.
 */
export function buildSnapshot(
  prev: MarketSnapshot | undefined,
  symbol: string,
  price: string,
  open24h: string,
  source: PriceSource,
  now: number,
  quoteAt: number = now,
  confirmed = true,
): MarketSnapshot {
  let spark = prev?.spark ? [...prev.spark] : [];
  const prevMinute = prev ? Math.floor((prev.checkedAt ?? prev.updatedAt) / SPARK_INTERVAL_MS) : -1;
  const minute = Math.floor(now / SPARK_INTERVAL_MS);
  if (!spark.length || minute > prevMinute) {
    // After downtime, fill the missing minutes with the last known price so the line
    // still covers exactly the last hour instead of splicing stale history onto now.
    const gap = Math.min(SPARK_POINTS, minute - prevMinute - 1);
    const last = spark[spark.length - 1];
    if (last !== undefined) for (let i = 0; i < gap; i++) spark.push(last);
    spark.push(price);
  } else spark[spark.length - 1] = price;
  if (spark.length > SPARK_POINTS) spark = spark.slice(-SPARK_POINTS);
  return { symbol, price, mark: markOf(price), open24h, spark, source, updatedAt: Math.min(quoteAt, now), checkedAt: now, ...(confirmed ? {} : { unconfirmed: true as const }) };
}
