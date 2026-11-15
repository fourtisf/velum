import { CANDLE_CACHE_SIZE, MAX_FUTURE_SKEW_MS, REAL_PRICE_SOURCES, TIMEFRAMES, getMarket, type Timeframe } from '@velum/config';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';
import { notFound } from '../lib/errors';
import { createMemo } from '../lib/memo';

interface CandlesRoute {
  Params: { symbol: string };
  Querystring: { tf: Timeframe; limit: number };
}

/**
 * GET /v1/markets/:symbol/candles. The workers' Redis cache first (authenticated and validated: shape,
 * bounds, no future buckets, written for this network); otherwise Postgres, where concurrent requests
 * for the same series share one query (audit I-4). Postgres never returns buckets dated ahead of now
 * (audit L-1). On mainnet only real history is served, from either: a cache built from a simulated
 * source is skipped (audit F-3: an earlier testnet run may have left one in Redis), and Postgres returns
 * only candles tagged with a real source (audit I-7, F-4).
 */
export function candlesRoutes(deps: AppDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  const memo = createMemo(now);
  const mainnet = deps.env.network === 'mainnet';
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
        const usable = cached && cached.network === deps.env.network && (!mainnet || REAL_PRICE_SOURCES.includes(cached.source));
        if (usable && cached.candles.length) return cached.candles.slice(-limit);
        return memo(`${seed.symbol}:${tf}:${limit}`, 0, () => deps.db.candles(seed.symbol, tf, limit, { until: now() + MAX_FUTURE_SKEW_MS, realOnly: mainnet }));
      },
    );
  };
}
