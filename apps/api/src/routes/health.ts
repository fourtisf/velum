import { usEquitySession } from '@velum/config';
import type { OnchainStatus, RoleHealth, SignerStatus } from '@velum/config/src/onchain';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';

export const PRICE_WORKER = 'price-relay';
/** Liveness heartbeat the workers process writes every few seconds (apps/workers/src/lib/liveness.ts). */
export const WORKERS_HEARTBEAT = 'workers';

/** The on-chain status counts as current for this long (the workers write it every 5 s). */
export const ONCHAIN_STATUS_MAX_AGE_S = 60;
/** The signer's status counts as current for this long (velum-signer writes it every 5 s). */
export const SIGNER_STATUS_MAX_AGE_S = 60;
/** A role whose last successful tick is older than max(this, 5 ticks) is not ok (audit M-3). */
export const ONCHAIN_TICK_MAX_AGE_S = 60;
/** During an open session, no confirmed push for longer than this many push intervals is not ok (audit M-3). */
export const ONCHAIN_PUSH_MAX_INTERVALS = 2;
const MAX_REASONS = 10;

/**
 * The workers' status (the indexer, from Redis) with the signer's (the relayer and the keeper, from velum-signer's status
 * file; on-chain audit M-2) laid over it: the signer's relayer, keeper and their roles replace the workers' (which run
 * neither since the split; a status from an older release still carries its own). Returns the combined status and the
 * reasons only the combination can tell: no signer status (or a stale one) while the workers run on-chain, the signer
 * idle with an error although requested, or no workers' status while the signer runs.
 */
export function withSigner(s: OnchainStatus | null, signer: SignerStatus | null, now: number): { status: OnchainStatus | null; reasons: string[]; signerAge: number | null } {
  const reasons: string[] = [];
  const signerAge = signer ? Math.max(0, Math.round((now - signer.at) / 1000)) : null;
  const workersOn = s !== null && s.deployment !== '' && !s.error;
  if (!signer || !signer.requested) {
    if (workersOn && !s!.relayer.enabled && !s!.keeper.enabled) reasons.push(signer ? 'signer: ONCHAIN_WORKERS is not true in its settings (velum-signer runs neither the relayer nor the keeper)' : 'signer: no status from velum-signer (it is not running, or cannot write its status file)');
    return { status: s, reasons, signerAge };
  }
  if (signerAge !== null && signerAge > SIGNER_STATUS_MAX_AGE_S) reasons.push(`signer: status is ${signerAge} s old`);
  if (signer.error) reasons.push(`signer: ${signer.error.slice(0, 160)}`);
  if (!s) reasons.push('indexer: no on-chain status from the workers');
  const idx = s?.indexer ?? { enabled: false, block: null, head: null, lagBlocks: null, lastRunAt: null, reorgs: 0, error: null };
  const base: OnchainStatus = s ?? { v: 1, at: signer.at, chainId: signer.chainId, deployment: signer.deployment, indexer: idx, relayer: signer.relayer, keeper: signer.keeper };
  const offRole: RoleHealth = { enabled: false, lockHeld: null, lastOkAt: null, everyMs: 0 };
  const status: OnchainStatus = {
    ...base,
    relayer: signer.relayer,
    keeper: signer.keeper,
    // The relayer's "no push since the start" check runs from the signer's start.
    startedAt: signer.startedAt,
    pushIntervalMs: signer.pushIntervalMs || base.pushIntervalMs,
    roles: { relayer: { ...signer.roles.relayer }, keeper: { ...signer.roles.keeper }, indexer: { ...(base.roles?.indexer ?? offRole) } },
  };
  // The indexer's first tick is judged from the workers' start.
  if (status.roles!.indexer.enabled && status.roles!.indexer.lastOkAt === null) status.roles!.indexer.lastOkAt = base.startedAt ?? null;
  // The signer's own start time judges its roles' first tick (its process may be younger than the workers').
  for (const r of [status.roles!.relayer, status.roles!.keeper]) if (r.enabled && r.lastOkAt === null) r.lastOkAt = signer.startedAt;
  return { status, reasons, signerAge };
}

/**
 * Summary of the Phase 3 on-chain workers for /v1/health, or null when they are off (no status written in
 * the last two minutes, and no signer status). With `signer` (velum-signer's status file), the relayer and keeper come
 * from it (withSigner). No secrets: addresses are public, error texts and alerts are redacted by the workers.
 * `ok` is false, with each cause in `reasons`, when: the status is old; the on-chain workers are disabled although
 * ONCHAIN_WORKERS=true (invalid settings, Redis not a unix socket: `error`); the indexer reports an error; an enabled
 * hot wallet is low, stuck, failing or raised an alert (an unused nonce, a failed gap fill, reverted pushes, a price
 * outside the oracle bounds); a role's lock is held by someone else, or its last successful tick is overdue; or,
 * during an open US-equity session, the relayer (enabled, sending, sequencer not down) has confirmed no push for
 * more than two push intervals (audit M-3: a Redis tenant holding the locks or deleting the schedulers no longer
 * looks healthy). It never makes /v1/health answer 503 (a low relay balance must not block a release).
 */
export function onchainSummary(workers: OnchainStatus | null, now: number, sessionOpen: (t: number) => boolean = (t) => usEquitySession(t).open, signer?: SignerStatus | null) {
  const combined = signer === undefined ? { status: workers, reasons: [], signerAge: null } : withSigner(workers, signer, now);
  const s = combined.status;
  if (!s) return null;
  const age = (t: number | null) => (t === null ? null : Math.max(0, Math.round((now - t) / 1000)));
  const short = (e: string | null) => (e === null ? null : e.slice(0, 160));
  const { indexer: i, relayer: r, keeper: k } = s;
  const statusAge = age(s.at) ?? 0;
  const reasons: string[] = [...combined.reasons];
  if (statusAge > ONCHAIN_STATUS_MAX_AGE_S) reasons.push(`status is ${statusAge} s old`);
  if (s.error) reasons.push(`on-chain workers disabled: ${short(s.error)}`);
  if (i.error !== null) reasons.push(`indexer: ${short(i.error)}`);
  for (const [name, x] of [['relayer', r], ['keeper', k]] as const) {
    if (!x.enabled) continue;
    if (x.balanceLow) reasons.push(`${name}: hot wallet balance below the alert threshold`);
    if (x.stuck) reasons.push(`${name}: a transaction is stuck`);
    if (x.error !== null) reasons.push(`${name}: ${short(x.error)}`);
    for (const a of x.alerts ?? []) reasons.push(`${name}: ${short(a)}`);
  }
  if (s.roles) {
    for (const [name, role] of Object.entries(s.roles) as Array<[string, RoleHealth]>) {
      if (!role.enabled) continue;
      if (role.lockHeld === false) reasons.push(`${name}: this process does not hold the role's lock (another instance runs it, or someone else holds it)`);
      const last = age(role.lastOkAt ?? s.startedAt ?? null);
      const limit = Math.max(ONCHAIN_TICK_MAX_AGE_S, Math.ceil((5 * role.everyMs) / 1000));
      if (last !== null && last > limit) reasons.push(`${name}: no successful tick for ${last} s`);
    }
  }
  if (r.enabled && r.sending && r.sequencerUp !== false && s.pushIntervalMs && sessionOpen(now)) {
    const last = r.lastPushAt ?? s.startedAt ?? null;
    if (last !== null && now - last > ONCHAIN_PUSH_MAX_INTERVALS * s.pushIntervalMs) reasons.push(`relayer: no confirmed push for ${age(last)} s during the market session`);
  }
  return {
    ok: reasons.length === 0,
    reasons: reasons.slice(0, MAX_REASONS),
    age: statusAge,
    signerAge: combined.signerAge,
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
 * Keep `"workers":<n>` followed by another field: deploy.sh reads it with a pattern. `signer` is the number of seconds
 * since velum-signer (the relayer and the keeper, their own Unix user, on-chain audit M-2) last wrote its status file
 * (null when there is none); deploy.sh checks it after a release that runs the signer (`"signer":<n>` too, followed by
 * another field). `onchain` (Phase 3): the relayer, keeper and indexer summary (onchainSummary), null while they are off.
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
      // The signer's status comes from its file, not from Redis: it is read even while Redis is down.
      const signerRaw = deps.signer ? await deps.signer.status().catch(() => null) : null;
      const signer = signerRaw && signerRaw.chainId === deps.env.chainId ? signerRaw : null;
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
        signer: signer ? Math.max(0, Math.round((now() - signer.at) / 1000)) : null,
        db,
        redis,
        demoMode: true,
        rpcChainId,
        onchain: onchainSummary(onchain, now(), undefined, deps.signer ? signer : undefined),
      });
    });
  };
}
