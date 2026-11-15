import { CANDLE_CACHE_SIZE, MAX_FUTURE_SKEW_MS, TIMEFRAMES, getMarket, type Timeframe } from '@velum/config';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';
import { notFound } from '../lib/errors';
import { createMemo } from '../lib/memo';

interface CandlesRoute {
  Params: { symbol: string };
  Querystring: { tf: Timeframe; limit: number };
}

/**
 * GET /v1/markets/:symbol/candles. The workers' Redis cache first (validated: shape, bounds, no future
 * buckets); otherwise Postgres, where concurrent requests for the same series share one query (audit
 * I-4). Postgres never returns buckets dated ahead of now (audit L-1) and, on mainnet, only candles built
 * from a real price source (audit I-7).
 */
export function candlesRoutes(deps: AppDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  const memo = createMemo(now);
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
        return memo(`${seed.symbol}:${tf}:${limit}`, 0, () =>
          deps.db.candles(seed.symbol, tf, limit, { until: now() + MAX_FUTURE_SKEW_MS, realOnly: deps.env.network === 'mainnet' }),
        );
      },
    );
  };
}
