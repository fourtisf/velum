import { cacheKeys } from '@velum/config';
import { buildSnapshot } from '../lib/snapshot';
import { PRICE_WORKER, type CandleJobData, type WorkerContext } from '../context';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const OPEN_REFRESH_MS = 60_000;

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

/** One price tick: read prices, publish snapshots, store ticks, hand the tick to the candles job. */
export async function runPriceRelay(ctx: WorkerContext, now = Date.now()): Promise<CandleJobData | null> {
  const last = new Map([...ctx.snapshots].map(([k, v]) => [k, v.price]));
  const prices = await ctx.source.read(last, now);
  if (prices.size === 0) return null;

  await refreshOpen24h(ctx, now).catch((err: unknown) => ctx.log.warn('open24h refresh failed', { err: String(err) }));

  const pipe = ctx.redis.pipeline();
  const ticks: Array<{ marketId: string; price: string; source: string; at: Date }> = [];
  const tickSource = ctx.source.name === 'chainlink' ? 'oracle' : 'demo';
  for (const [symbol, price] of prices) {
    const prev = ctx.snapshots.get(symbol);
    const open = ctx.open24h.get(symbol) ?? prev?.open24h ?? price;
    const snap = buildSnapshot(prev, symbol, price, open, ctx.source.name, now);
    ctx.snapshots.set(symbol, snap);
    pipe.set(cacheKeys.price(symbol), JSON.stringify(snap));
    const marketId = ctx.marketIds.get(symbol);
    if (marketId) ticks.push({ marketId, price, source: tickSource, at: new Date(now) });
  }
  pipe.set(cacheKeys.heartbeat(PRICE_WORKER), String(now));
  await pipe.exec();
  if (ticks.length) await ctx.prisma.priceTick.createMany({ data: ticks });

  const data: CandleJobData = { at: now, prices: Object.fromEntries(prices) };
  await ctx.enqueueCandles(data);
  return data;
}
