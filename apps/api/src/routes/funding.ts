import { getMarket } from '@velum/config';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';
import { ApiError, notFound } from '../lib/errors';
import { NOT_DEPLOYED } from './deployment';

interface FundingRoute {
  Params: { symbol: string };
  Querystring: { limit: number };
}

/**
 * GET /v1/markets/:symbol/funding (Phase 3): the market's funding index after each FundingAdvanced event of
 * the current deployment, oldest first (the newest `limit`). `rate` is percent per hour (positive: longs pay
 * shorts), `index` the cumulative funding per token in USDG. 404 for an unknown market, one the deployment
 * does not list, or before any deployment.
 */
export function fundingRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    app.get<FundingRoute>(
      '/v1/markets/:symbol/funding',
      {
        schema: {
          params: { type: 'object', properties: { symbol: { type: 'string', maxLength: 12 } }, required: ['symbol'] },
          querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 48 } } },
        },
      },
      async (req) => {
        const seed = getMarket(req.params.symbol);
        if (!seed) throw notFound(`No market called ${req.params.symbol.toUpperCase()}.`);
        const d = deps.deployment?.get() ?? null;
        if (!d) throw notFound(NOT_DEPLOYED);
        const token = d.tokens[seed.symbol];
        if (!token) throw notFound(`${seed.symbol} is not listed in this deployment.`);
        if (!deps.onchain) throw new ApiError(503, 'UNAVAILABLE', 'The index is temporarily unavailable. Try again in a moment.');
        try {
          return await deps.onchain.funding(d, token, req.query.limit);
        } catch {
          throw new ApiError(503, 'UNAVAILABLE', 'The index is temporarily unavailable. Try again in a moment.');
        }
      },
    );
  };
}
