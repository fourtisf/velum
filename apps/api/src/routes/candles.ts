import { CANDLE_CACHE_SIZE, TIMEFRAMES, getMarket, type Timeframe } from '@velum/config';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';
import { notFound } from '../lib/errors';

interface CandlesRoute {
  Params: { symbol: string };
  Querystring: { tf: Timeframe; limit: number };
}

export function candlesRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    app.get<CandlesRoute>(
      '/v1/markets/:symbol/candles',
      {
        schema: {
          params: { type: 'object', properties: { symbol: { type: 'string', maxLength: 12 } }, required: ['symbol'] },
          querystring: {
            type: 'object',
            properties: {
              tf: { type: 'string', enum: [...TIMEFRAMES], default: '1h' },
              limit: { type: 'integer', minimum: 1, maximum: CANDLE_CACHE_SIZE, default: 120 },
            },
          },
        },
      },
      async (req) => {
        const seed = getMarket(req.params.symbol);
        if (!seed) throw notFound(`No market called ${req.params.symbol.toUpperCase()}.`);
        const { tf, limit } = req.query;
        const cached = await deps.cache.candles(seed.symbol, tf).catch(() => null);
        if (cached && cached.length) return cached.slice(-limit);
        return deps.db.candles(seed.symbol, tf, limit);
      },
    );
  };
}
