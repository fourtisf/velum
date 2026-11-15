import type { OnchainStatus } from '@velum/config/src/onchain';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';

export const PRICE_WORKER = 'price-relay';
/** Liveness heartbeat the workers process writes every few seconds (apps/workers/src/lib/liveness.ts). */
export const WORKERS_HEARTBEAT = 'workers';

/** The on-chain status counts as current for this long (the workers write it every 5 s). */
export const ONCHAIN_STATUS_MAX_AGE_S = 60;

/**
 * Summary of the Phase 3 on-chain workers for /v1/health, or null when they are off (no status written in
 * the last two minutes). No secrets: addresses are public, error texts are redacted by the workers. `ok` is
 * false when the status is old, the indexer reports an error, or an enabled hot wallet is low, stuck or
 * failing. It never makes /v1/health answer 503 (a low relay balance must not block a release).
 */
export function onchainSummary(s: OnchainStatus | null, now: number) {
  if (!s) return null;
  const age = (t: number | null) => (t === null ? null : Math.max(0, Math.round((now - t) / 1000)));
  const short = (e: string | null) => (e === null ? null : e.slice(0, 160));
  const { indexer: i, relayer: r, keeper: k } = s;
  const bad = (x: { enabled: boolean; balanceLow: boolean; stuck: boolean; error: string | null }) => x.enabled && (x.balanceLow || x.stuck || x.error !== null);
  const statusAge = age(s.at) ?? 0;
  return {
    ok: statusAge <= ONCHAIN_STATUS_MAX_AGE_S && i.error === null && !bad(r) && !bad(k),
    age: statusAge,
    chainId: s.chainId,
    indexer: { block: i.block, head: i.head, lag: i.lagBlocks, reorgs: i.reorgs, lastRun: age(i.lastRunAt), error: short(i.error) },
    relayer: {
      enabled: r.enabled,
      address: r.address,
      sending: r.sending,
      lastPush: age(r.lastPushAt),
      balanceLow: r.balanceLow,
      stuck: r.stuck,
      gasCapped: r.gasCapped,
      sequencerUp: r.sequencerUp,
      markets: r.markets,
      error: short(r.error),
    },
    keeper: {
      enabled: k.enabled,
      address: k.address,
      sending: k.sending,
      lastRun: age(k.lastRunAt),
      balanceLow: k.balanceLow,
      stuck: k.stuck,
      gasCapped: k.gasCapped,
      liquidations: k.liquidations,
      forcedExits: k.forcedExits,
      error: short(k.error),
    },
  };
}

/**
 * GET /v1/health
 * `lag` is the number of seconds since the price-relay worker last wrote prices (null if it
 * never ran); the indexer's block lag is `onchain.indexer.lag` (Phase 3). `workers` is the number of seconds
 * since the workers process last reported alive (null if never), whether or not a price source has
 * quotes; deploy/deploy.sh checks it after each release (audit R2-L5). `block` is null when the RPC
 * is unreachable; that alone does not fail the check. `rpcChainId` is RPC_URL's eth_chainId (null until
 * the RPC answered, audit I-5). 503 when Postgres or Redis is down, or when RPC_URL serves another chain
 * than CHAIN_ID. `demoMode` is always true in Phase 2: every trade is simulated (audit DV-08).
 * Rate limited per IP (RATE_LIMIT_HEALTH_PER_MIN): each call pings Postgres and Redis (audit L6).
 * Keep `"workers":<n>` followed by another field: deploy.sh reads it with a pattern. `onchain` (Phase 3):
 * the relayer, keeper and indexer summary (onchainSummary), null while they are off.
 */
export function healthRoutes(deps: AppDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  return async (app) => {
    app.get('/v1/health', { config: { rateLimit: { max: deps.env.rateHealthPerMin, timeWindow: '1 minute' } } }, async (_req, reply) => {
      const [db, redis, block, rpcChainId] = await Promise.all([
        deps.db.ping(),
        deps.cache.ping(),
        deps.chain.blockNumber(),
        deps.chain.chainId ? deps.chain.chainId().catch(() => null) : Promise.resolve(null),
      ]);
      let lag: number | null = null;
      let workers: number | null = null;
      let onchain: OnchainStatus | null = null;
      if (redis) {
        const age = (t: number | null) => (t === null ? null : Math.max(0, Math.round((now() - t) / 1000)));
        const [hb, alive, status] = await Promise.all([
          deps.cache.heartbeat(PRICE_WORKER).catch(() => null),
          deps.cache.heartbeat(WORKERS_HEARTBEAT).catch(() => null),
          deps.cache.onchainStatus ? deps.cache.onchainStatus().catch(() => null) : Promise.resolve(null),
        ]);
        lag = age(hb);
        workers = age(alive);
        // Only the status written for the chain this API serves.
        onchain = status && status.chainId === deps.env.chainId ? status : null;
      }
      const chainOk = rpcChainId === null || rpcChainId === deps.env.chainId;
      const ok = db && redis && chainOk;
      return reply.code(ok ? 200 : 503).send({
        ok,
        chainId: deps.env.chainId,
        block: block === null ? null : Number(block),
        lag,
        workers,
        db,
        redis,
        demoMode: true,
        rpcChainId,
        onchain: onchainSummary(onchain, now()),
      });
    });
  };
}
