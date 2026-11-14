import { POOLS, PROTOCOL, getMarket } from '@velum/config';
import { parseWad, roundSig, toDecimalString } from '@velum/math';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';

const HOUR = 3_600_000;
const SIG = PROTOCOL.publicAggregate.sigFigs;

const round = (s: string): string => toDecimalString(roundSig(parseWad(s) ?? 0n, SIG, 'floor'));

/**
 * GET /v1/pools. Sizes are public aggregates: published hourly, rounded to 2 significant
 * figures. Uses published PoolHourly rows when any exist, otherwise the demo seed.
 */
export function poolsRoutes(deps: AppDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  return async (app) => {
    app.get('/v1/pools', async () => {
      const published = await deps.db.publishedPools().catch(() => []);
      const bySymbol = new Map(published.map((p) => [p.symbol, p]));
      const hour = Math.floor(now() / HOUR) * HOUR;
      return POOLS.map((seed) => {
        const live = bySymbol.get(seed.symbol);
        const useSeed = !live && deps.env.demoMode;
        return {
          symbol: seed.symbol,
          pair: `${seed.symbol}/USDG`,
          feeBps: live?.feeBps ?? PROTOCOL.spotPoolFeeBps,
          sizeRounded: live ? round(live.sizeRounded) : useSeed ? round(seed.size) : null,
          aprEst: live ? live.aprEst : useSeed ? seed.aprEst : null,
          updatedHour: live?.hour ?? hour,
          status: getMarket(seed.symbol)?.status ?? 'coming_soon',
        };
      });
    });
  };
}
