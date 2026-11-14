import type { WorkerContext } from '../context';

/** Delete price ticks older than PRICE_TICK_RETENTION_DAYS. Candles are kept. */
export async function runPrune(ctx: WorkerContext, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - ctx.env.tickRetentionDays * 86_400_000);
  const { count } = await ctx.prisma.priceTick.deleteMany({ where: { at: { lt: cutoff } } });
  if (count) ctx.log.info('pruned price ticks', { count, before: cutoff.toISOString() });
  return count;
}
