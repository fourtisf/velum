import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';
import { DEFAULT_PERPS_BLOCKED } from '../lib/geo';

/**
 * GET /v1/geo: the visitor's country (lib/geo.ts) and whether Velum offers perps there. `perps` is "blocked" for a
 * country in PERPS_BLOCKED_COUNTRIES, "allowed" for any other known country, and "unknown" when no country source is
 * configured or the lookup finds nothing (the web then relies on the user's statement in the perps terms). Never
 * cached: the answer depends on the visitor's address.
 */
export function geoRoutes(deps: AppDeps): FastifyPluginAsync {
  const blocked = new Set(deps.env.perpsBlocked ?? DEFAULT_PERPS_BLOCKED);
  return async (app) => {
    app.get('/v1/geo', async (req, reply) => {
      const country = deps.geo ? deps.geo.country(req) : null;
      reply.header('cache-control', 'private, no-store');
      return { country, perps: country === null ? 'unknown' : blocked.has(country) ? 'blocked' : 'allowed' };
    });
  };
}
