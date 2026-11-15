import { DEMO, MARKETS } from '@velum/config';
import { parseWad, toDecimalString } from '@velum/math';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';

const DAY = 86_400_000;
const OPEN_INTEREST = toDecimalString(MARKETS.reduce((a, m) => a + (parseWad(m.openInterest) ?? 0n), 0n));

/** Deterministic value in [-1, 1] per UTC day, so the demo count differs day to day. */
function dayJitter(day: number): number {
  let x = (day * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x / 0xffffffff) * 2 - 1;
}

/** Demo proofs verified today: grows through the UTC day, never decreases within a day. */
export function demoProofsToday(now: number): number {
  const day = Math.floor(now / DAY);
  const frac = (now - day * DAY) / DAY;
  return Math.floor(DEMO.proofsTodayBase * frac * (1 + 0.02 * dayJitter(day)));
}

/**
 * GET /v1/stats. Open interest, shielded value and proofs have no real source before Phases 3-4: on
 * testnet they are demo values and the answer says "demo": true; on mainnet they are null (audit DV-03).
 */
export function statsRoutes(deps: AppDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  const demo = deps.env.network !== 'mainnet';
  return async (app) => {
    app.get('/v1/stats', async () => ({
      markets: MARKETS.length,
      openInterest: demo ? OPEN_INTEREST : null,
      shieldedValue: demo ? DEMO.shieldedValue : null,
      proofsToday: demo ? demoProofsToday(now()) : null,
      demo,
    }));
  };
}
