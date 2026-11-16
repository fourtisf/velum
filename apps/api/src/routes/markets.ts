import { MARKETS, MARKET_SYMBOLS, getMarket } from '@velum/config';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';
import { notFound } from '../lib/errors';
import { marketView } from '../lib/market-view';
import { createMemo } from '../lib/memo';
import { CACHE_READ_TIMEOUT_MS, snapshotReader } from '../lib/snapshots';
import { timeout } from '../lib/memo';
import type { PerpRef } from '@velum/config/src/perps-ref';

/** How long one /v1/markets answer is reused by this API instance (audit L-5; the web polls every 2 s). */
export const MARKETS_CACHE_MS = 1000;

/**
 * GET /v1/markets and /v1/markets/:symbol. Answers come from a 1 s in-process cache (one Redis read per
 * second per instance however many clients poll) and have their own per-client budget,
 * RATE_LIMIT_MARKETS_PER_MIN (audit L-5). When Redis is down they still answer, from the last values
 * this instance saw (or the seed price), all marked stale with staleReason "unavailable" (audit L-4).
 */
export function marketsRoutes(deps: AppDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  const read = snapshotReader(deps.cache);
  // Lighter perps metrics (mainnet): best effort, an unreadable cache means none (never an error, never stale data).
  const mainnet = deps.env.network === 'mainnet';
  const readRefs = async (symbols: readonly string[]): Promise<Map<string, PerpRef>> => {
    if (!mainnet || !deps.cache.perpRefs) return new Map();
    try {
      return await timeout(deps.cache.perpRefs(symbols), CACHE_READ_TIMEOUT_MS, 'perps reference read');
    } catch {
      return new Map();
    }
  };
  const memo = createMemo(now);
  const rateLimit = { max: deps.env.rateMarketsPerMin, timeWindow: '1 minute' };
  return async (app) => {
    app.get('/v1/markets', { config: { rateLimit } }, async () =>
      memo('all', MARKETS_CACHE_MS, async () => {
        const [{ snaps, ok }, refs] = await Promise.all([read(MARKET_SYMBOLS), readRefs(MARKET_SYMBOLS)]);
        const t = now();
        return MARKETS.map((m) => marketView(m, snaps.get(m.symbol), t, deps.env.network, ok, refs.get(m.symbol)));
      }),
    );

    app.get<{ Params: { symbol: string } }>(
      '/v1/markets/:symbol',
      { config: { rateLimit }, schema: { params: { type: 'object', properties: { symbol: { type: 'string', maxLength: 12 } }, required: ['symbol'] } } },
      async (req) => {
        const seed = getMarket(req.params.symbol);
        if (!seed) throw notFound(`No market called ${req.params.symbol.toUpperCase()}.`);
        return memo(seed.symbol, MARKETS_CACHE_MS, async () => {
          const [{ snaps, ok }, refs] = await Promise.all([read([seed.symbol]), readRefs([seed.symbol])]);
          return marketView(seed, snaps.get(seed.symbol), now(), deps.env.network, ok, refs.get(seed.symbol));
        });
      },
    );
  };
}
