import { TIMEFRAME_MS, cacheKeys, type PriceSource, type Timeframe } from '@velum/config';
import { toDecimalString } from '@velum/math';
import type { WadCandle } from '../lib/candles';
import { buildSnapshot, quoteConfirmed, quoteTime } from '../lib/snapshot';
import { PRICE_WORKER, seriesKey, type CandleJobData, type WorkerContext } from '../context';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const OPEN_REFRESH_MS = 60_000;

/** PriceTick.source for a price source ("oracle" for Chainlink, as before). */
export const tickSourceOf = (source: PriceSource): string => (source === 'chainlink' ? 'oracle' : source);

/**
 * Refresh 24h opens once a minute. Live quote sources use the earliest tick of the last 24h. Uniswap uses its candles
 * (real trades, backfilled from the chain; open24hFromSeries) and falls back to ticks only for a market whose candles
 * do not reach back a day yet, never overwriting one that has them. Demo keeps its seeded open until about a full day
 * of ticks exists.
 */
export async function refreshOpen24h(ctx: WorkerContext, now: number): Promise<void> {
  if (now - ctx.lastOpenRefresh < OPEN_REFRESH_MS) return;
  ctx.lastOpenRefresh = now;
  const since = now - DAY;
  const fromTicks = new Set(ctx.marketIds.keys());
  if (ctx.source.name === 'uniswap') {
    for (const symbol of ctx.marketIds.keys()) {
      const open = open24hFromSeries((tf) => ctx.series.get(seriesKey(symbol, tf)), since);
      if (open) {
        ctx.open24h.set(symbol, open);
        fromTicks.delete(symbol);
      }
    }
    if (!fromTicks.size) return;
  }
  await Promise.all(
    [...ctx.marketIds]
      .filter(([symbol]) => fromTicks.has(symbol))
      .map(async ([symbol, marketId]) => {
        const first = await ctx.prisma.priceTick.findFirst({
          where: { marketId, at: { gte: new Date(since) } },
          orderBy: { at: 'asc' },
          select: { price: true, at: true },
        });
        if (!first) return;
        const fullDay = first.at.getTime() <= since + HOUR;
        const demo = ctx.source.name === 'demo';
        if (!demo || fullDay || !ctx.open24h.has(symbol)) ctx.open24h.set(symbol, first.price.toFixed());
      }),
  );
}

/** Timeframes tried for the price 24h ago, finest first. */
const OPEN_TFS: readonly Timeframe[] = ['15m', '1h', '4h', '1D'];

/**
 * The price at `since` (the last trade by then) from the candle series of one market (each oldest first), or null
 * when none reaches back that far: the close of the last 15-minute bucket starting at or before `since`, else of the
 * last 1h, 4h or 1D bucket that ended by then (a coarser bucket still open at `since` holds later trades).
 */
export function open24hFromSeries(get: (tf: Timeframe) => readonly WadCandle[] | undefined, since: number): string | null {
  for (const tf of OPEN_TFS) {
    const span = tf === '15m' ? 0 : TIMEFRAME_MS[tf];
    let pick: WadCandle | undefined;
    for (const c of get(tf) ?? []) {
      if (c.t + span > since) break;
      pick = c;
    }
    if (pick) return toDecimalString(pick.c);
  }
  return null;
}

/** The price at `since` from a 15-minute series alone (see open24hFromSeries). */
export const open24hFromCandles = (series: readonly WadCandle[], since: number): string | null => open24hFromSeries((tf) => (tf === '15m' ? series : undefined), since);

/**
 * One price tick: read prices, publish snapshots, store ticks, hand the tick to the candles job.
 * Runs at most once per half poll interval: a flood of price jobs (an extra scheduler, or jobs another
 * client of a shared Redis adds, audit M-2) cannot hammer the upstream's rate limit.
 */
export async function runPriceRelay(ctx: WorkerContext, now = Date.now()): Promise<CandleJobData | null> {
  const minGap = (ctx.env?.pricePollMs ?? 0) / 2;
  if (ctx.lastRelayAt !== undefined && now >= ctx.lastRelayAt && now - ctx.lastRelayAt < minGap) return null;
  ctx.lastRelayAt = now;
  const last = new Map([...ctx.snapshots].map(([k, v]) => [k, v.price]));
  // A market without a snapshot is checked against its newest stored tick (audit F-6): the jump guard
  // would otherwise accept any first quote after a lost snapshot.
  for (const [symbol, price] of ctx.lastTickPrice ?? []) if (!last.has(symbol)) last.set(symbol, price);
  const prices = await ctx.source.read(last, now);
  if (prices.size === 0) return null;

  await refreshOpen24h(ctx, now).catch((err: unknown) => ctx.log.warn('open24h refresh failed', { err: String(err) }));

  const pipe = ctx.redis.pipeline();
  const ticks: Array<{ marketId: string; price: string; source: string; at: Date }> = [];
  const tickSource = tickSourceOf(ctx.source.name);
  for (const [symbol, price] of prices) {
    const prev = ctx.snapshots.get(symbol);
    const open = ctx.open24h.get(symbol) ?? prev?.open24h ?? price;
    // Stamped with the quote time, not the poll time (audit M-1): a frozen quote keeps aging. Without a
    // previous snapshot the quote time is unknown: not live until the quote changes (audit F-6).
    const sourceTime = ctx.source.quoteTimes?.get(symbol);
    const quoteAt = quoteTime(prev, price, ctx.source.name, now, sourceTime);
    const confirmed = quoteConfirmed(prev, price, ctx.source.name, sourceTime);
    const snap = buildSnapshot(prev, symbol, price, open, ctx.source.name, now, quoteAt, confirmed);
    ctx.snapshots.set(symbol, snap);
    pipe.set(cacheKeys.price(symbol), ctx.mac.seal(cacheKeys.price(symbol), JSON.stringify(snap)));
    const marketId = ctx.marketIds.get(symbol);
    if (marketId) ticks.push({ marketId, price, source: tickSource, at: new Date(now) });
  }
  pipe.set(cacheKeys.heartbeat(PRICE_WORKER), ctx.mac.seal(cacheKeys.heartbeat(PRICE_WORKER), String(now)));
  await pipe.exec();
  if (ticks.length) await ctx.prisma.priceTick.createMany({ data: ticks });

  // The candles job reads these ticks back from Postgres (jobs/candles.ts): the prices here are for
  // tests and logs only, a job's payload is never trusted (audit M-2).
  const data: CandleJobData = { at: now, prices: Object.fromEntries(prices) };
  await ctx.enqueueCandles(data);
  return data;
}
