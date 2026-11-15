import { cacheKeys, type PriceSource } from '@velum/config';
import { buildSnapshot, quoteConfirmed, quoteTime } from '../lib/snapshot';
import { PRICE_WORKER, type CandleJobData, type WorkerContext } from '../context';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const OPEN_REFRESH_MS = 60_000;

/** PriceTick.source for a price source ("oracle" for Chainlink, as before). */
export const tickSourceOf = (source: PriceSource): string => (source === 'chainlink' ? 'oracle' : source);

/**
 * Refresh 24h opens from PriceTick once a minute. Live sources use the earliest tick of the
 * last 24h. Demo keeps its seeded open until about a full day of ticks exists.
 */
export async function refreshOpen24h(ctx: WorkerContext, now: number): Promise<void> {
  if (now - ctx.lastOpenRefresh < OPEN_REFRESH_MS) return;
  ctx.lastOpenRefresh = now;
  const since = now - DAY;
  await Promise.all(
    [...ctx.marketIds].map(async ([symbol, marketId]) => {
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
