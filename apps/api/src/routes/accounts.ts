import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { parseActivityCursor, type PositionStatusFilter } from '../lib/onchain';
import { NOT_DEPLOYED } from './deployment';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const BAD_ADDRESS = 'address must be 0x followed by 40 hex digits (any letter case).';

/** The lower-case form of a path address (checksum-insensitive), or a 400. */
export function accountParam(raw: string): string {
  if (!ADDRESS_RE.test(raw)) throw badRequest(BAD_ADDRESS);
  return raw.toLowerCase();
}

const unavailable = () => new ApiError(503, 'UNAVAILABLE', 'The index is temporarily unavailable. Try again in a moment.');

interface PositionsRoute {
  Params: { address: string };
  Querystring: { status: PositionStatusFilter; limit: number };
}

interface ActivityRoute {
  Params: { address: string };
  Querystring: { limit: number; before?: string };
}

const addressParams = { type: 'object', properties: { address: { type: 'string', maxLength: 64 } }, required: ['address'] } as const;

/**
 * GET /v1/accounts/:address/positions and /v1/accounts/:address/activity (Phase 3), from the indexer's
 * tables for the current deployment. Addresses are accepted in any letter case and returned checksummed.
 * Activity is newest first, paginated with an opaque `before` cursor (`next` of the previous page).
 */
export function accountsRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    app.get<PositionsRoute>(
      '/v1/accounts/:address/positions',
      {
        schema: {
          params: addressParams,
          querystring: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['open', 'closed', 'all'], default: 'all' },
              limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            },
          },
        },
      },
      async (req) => {
        const account = accountParam(req.params.address);
        const d = deps.deployment?.get() ?? null;
        if (!d) throw notFound(NOT_DEPLOYED);
        if (!deps.onchain) throw unavailable();
        try {
          return await deps.onchain.positions(d, account, req.query.status, req.query.limit);
        } catch {
          throw unavailable();
        }
      },
    );

    app.get<ActivityRoute>(
      '/v1/accounts/:address/activity',
      {
        schema: {
          params: addressParams,
          querystring: {
            type: 'object',
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
              before: { type: 'string', maxLength: 40 },
            },
          },
        },
      },
      async (req) => {
        const account = accountParam(req.params.address);
        const before = parseActivityCursor(req.query.before);
        if (before === 'invalid') throw badRequest('before must be the `next` cursor of a previous page.');
        const d = deps.deployment?.get() ?? null;
        if (!d) throw notFound(NOT_DEPLOYED);
        if (!deps.onchain) throw unavailable();
        try {
          return await deps.onchain.activity(d, account, req.query.limit, before);
        } catch {
          throw unavailable();
        }
      },
    );
  };
}
