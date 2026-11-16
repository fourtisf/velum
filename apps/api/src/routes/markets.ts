import { MARKETS, MARKET_SYMBOLS, getMarket, usEquitySession, type DexSnapshot } from '@velum/config';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';
import { notFound } from '../lib/errors';
import { marketView } from '../lib/market-view';
import { createMemo, timeout } from '../lib/memo';
import { sessionClosesReader, type SessionCloses } from '../lib/session-change';
import { snapshotReader } from '../lib/snapshots';

/** How long one /v1/markets answer is reused by this API instance (audit L-5; the web polls every 2 s). */
export const MARKETS_CACHE_MS = 1000;
/** Longest wait for the closed-market extras (session closes, DEX snapshots) before answering without them. */
export const EXTRAS_TIMEOUT_MS = 400;

/**
 * GET /v1/markets and /v1/markets/:symbol. Answers come from a 1 s in-process cache (one Redis read per
 * second per instance however many clients poll) and have their own per-client budget,
 * RATE_LIMIT_MARKETS_PER_MIN (audit L-5). When Redis is down they still answer, from the last values
 * this instance saw (or the seed price), all marked stale with staleReason "unavailable" (audit L-4).
 */
export function marketsRoutes(deps: AppDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  const read = snapshotReader(deps.cache);
  const memo = createMemo(now);
  const closesOf = sessionClosesReader(deps.db);
  const rateLimit = { max: deps.env.rateMarketsPerMin, timeWindow: '1 minute' };
  const liveSymbols = MARKETS.filter((m) => m.status === 'live').map((m) => m.symbol);

  /**
   * While the market is closed: the last two session closes (Postgres, cached) and the DEX snapshots (Redis). Any
   * failure leaves them out (the market then shows a dash for the change), never fails the route.
   */
  const extrasFor = async (t: number, symbols: readonly string[]): Promise<{ closes: SessionCloses | null; dex: Map<string, DexSnapshot> }> => {
    if (usEquitySession(t).open) return { closes: null, dex: new Map() };
    const [closes, dex] = await Promise.all([
      timeout(closesOf(t, liveSymbols), EXTRAS_TIMEOUT_MS, 'session closes').catch(() => null),
      deps.cache.dexSnapshots ? timeout(deps.cache.dexSnapshots(symbols), EXTRAS_TIMEOUT_MS, 'DEX snapshots').catch(() => new Map<string, DexSnapshot>()) : Promise.resolve(new Map<string, DexSnapshot>()),
    ]);
    return { closes, dex };
  };

  return async (app) => {
    app.get('/v1/markets', { config: { rateLimit } }, async () =>
      memo('all', MARKETS_CACHE_MS, async () => {
        const { snaps, ok } = await read(MARKET_SYMBOLS);
        const t = now();
        const { closes, dex } = await extrasFor(t, MARKET_SYMBOLS);
        return MARKETS.map((m) => marketView(m, snaps.get(m.symbol), t, deps.env.network, ok, { closes, dex: dex.get(m.symbol) ?? null }));
      }),
    );

    app.get<{ Params: { symbol: string } }>(
      '/v1/markets/:symbol',
      { config: { rateLimit }, schema: { params: { type: 'object', properties: { symbol: { type: 'string', maxLength: 12 } }, required: ['symbol'] } } },
      async (req) => {
        const seed = getMarket(req.params.symbol);
        if (!seed) throw notFound(`No market called ${req.params.symbol.toUpperCase()}.`);
        return memo(seed.symbol, MARKETS_CACHE_MS, async () => {
          const { snaps, ok } = await read([seed.symbol]);
          const t = now();
          const { closes, dex } = await extrasFor(t, [seed.symbol]);
          return marketView(seed, snaps.get(seed.symbol), t, deps.env.network, ok, { closes, dex: dex.get(seed.symbol) ?? null });
        });
      },
    );
  };
}
