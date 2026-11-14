import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';

export const PRICE_WORKER = 'price-relay';

/**
 * GET /v1/health
 * `lag` is the number of seconds since the price-relay worker last wrote prices (null if it
 * never ran). In Phase 3+ it becomes the indexer's block lag. `block` is null when the RPC is
 * unreachable; that alone does not fail the check. 503 only when Postgres or Redis is down.
 * Rate limited per IP (RATE_LIMIT_HEALTH_PER_MIN): each call pings Postgres and Redis (audit L6).
 */
export function healthRoutes(deps: AppDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  return async (app) => {
    app.get('/v1/health', { config: { rateLimit: { max: deps.env.rateHealthPerMin, timeWindow: '1 minute' } } }, async (_req, reply) => {
      const [db, redis, block] = await Promise.all([deps.db.ping(), deps.cache.ping(), deps.chain.blockNumber()]);
      let lag: number | null = null;
      if (redis) {
        const hb = await deps.cache.heartbeat(PRICE_WORKER).catch(() => null);
        if (hb !== null) lag = Math.max(0, Math.round((now() - hb) / 1000));
      }
      const ok = db && redis;
      return reply.code(ok ? 200 : 503).send({
        ok,
        chainId: deps.env.chainId,
        block: block === null ? null : Number(block),
        lag,
        db,
        redis,
        demoMode: deps.env.demoMode,
      });
    });
  };
}
