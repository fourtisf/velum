import { MARKETS, MARKET_SYMBOLS, getMarket } from '@velum/config';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';
import { notFound } from '../lib/errors';
import { marketView } from '../lib/market-view';

export function marketsRoutes(deps: AppDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  return async (app) => {
    app.get('/v1/markets', async () => {
      const snaps = await deps.cache.snapshots(MARKET_SYMBOLS);
      const t = now();
      return MARKETS.map((m) => marketView(m, snaps.get(m.symbol), t));
    });

    app.get<{ Params: { symbol: string } }>(
      '/v1/markets/:symbol',
      { schema: { params: { type: 'object', properties: { symbol: { type: 'string', maxLength: 12 } }, required: ['symbol'] } } },
      async (req) => {
        const seed = getMarket(req.params.symbol);
        if (!seed) throw notFound(`No market called ${req.params.symbol.toUpperCase()}.`);
        const snaps = await deps.cache.snapshots([seed.symbol]);
        return marketView(seed, snaps.get(seed.symbol), now());
      },
    );
  };
}
