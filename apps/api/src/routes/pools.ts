import { POOLS, PROTOCOL, getMarket } from '@velum/config';
import { parseWad, roundSig, toDecimalString } from '@velum/math';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';
import { createMemo } from '../lib/memo';

const HOUR = 3_600_000;
const SIG = PROTOCOL.publicAggregate.sigFigs;
/** Published pool rows change once an hour: one query per 30 s per instance is plenty (audit I-4). */
export const POOLS_CACHE_MS = 30_000;

const round = (s: string): string => toDecimalString(roundSig(parseWad(s) ?? 0n, SIG, 'floor'));

/**
 * GET /v1/pools. Sizes are public aggregates: published hourly, rounded to 2 significant figures.
 * Uses published PoolHourly rows when any exist. Otherwise, on testnet, the demo seed with
 * "demo": true; on mainnet null (no real source yet, audit DV-03).
 */
export function poolsRoutes(deps: AppDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  const memo = createMemo(now);
  const testnet = deps.env.network !== 'mainnet';
  return async (app) => {
    app.get('/v1/pools', async () => {
      const published = await memo('pools', POOLS_CACHE_MS, () => deps.db.publishedPools()).catch(() => []);
      const bySymbol = new Map(published.map((p) => [p.symbol, p]));
      const hour = Math.floor(now() / HOUR) * HOUR;
      return POOLS.map((seed) => {
        const live = bySymbol.get(seed.symbol);
        const useSeed = !live && testnet;
        return {
          symbol: seed.symbol,
          pair: `${seed.symbol}/USDG`,
          feeBps: live?.feeBps ?? PROTOCOL.spotPoolFeeBps,
          sizeRounded: live ? round(live.sizeRounded) : useSeed ? round(seed.size) : null,
          aprEst: live ? live.aprEst : useSeed ? seed.aprEst : null,
          updatedHour: live?.hour ?? hour,
          status: getMarket(seed.symbol)?.status ?? 'coming_soon',
          demo: useSeed,
        };
      });
    });
  };
}
