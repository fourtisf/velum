import type { WorkerContext } from '../context';

/**
 * Delete price ticks older than PRICE_TICK_RETENTION_DAYS. Candles are kept. Uses the index on
 * PriceTick("at") (migration 20261115120100, audit F-8): an hourly run touches only the hour of ticks
 * that aged out instead of scanning the table.
 */
export async function runPrune(ctx: WorkerContext, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - ctx.env.tickRetentionDays * 86_400_000);
  const { count } = await ctx.prisma.priceTick.deleteMany({ where: { at: { lt: cutoff } } });
  if (count) ctx.log.info('pruned price ticks', { count, before: cutoff.toISOString() });
  return count;
}
