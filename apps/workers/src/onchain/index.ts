/**
 * Starts the Phase 3 indexer inside the workers process, on its own BullMQ queue (one job at a time) behind a Redis
 * role lock (one active instance), plus the status the API reports in /v1/health. Off unless ONCHAIN_WORKERS=true and
 * the deployment file of the chain exists.
 *
 * The price relayer and the keeper do not run here (on-chain audit M-2): they hold the hot keys, and this process runs
 * as the same Unix user as the internet-facing API. They run in the signer process (velum-signer, src/signer.ts) as
 * their own user, reading neither Redis nor Postgres; the API reads that process's status from its status file. This
 * process never receives a hot key (deploy/ecosystem.config.cjs refuses to pass one), and holds no signing code path.
 *
 * Redis (on-chain workers audit M-3): the role locks and the job schedulers live in Redis, so a tenant of a shared
 * Redis could hold the locks or delete the schedulers and stop every role. The on-chain workers therefore start only
 * when REDIS_URL is a unix socket (Velum's own Redis, deploy/redis-velum.sh); otherwise they stay off, say so in the
 * log and in /v1/health, and the Phase 2 workers run on. The status reports, per role, whether this process holds
 * its lock and when its last successful tick was; a role whose tick is overdue gets its job scheduler re-added.
 */
import type { CacheMac } from '@velum/config/src/cache-mac';
import { readDeploymentFile } from '@velum/config/src/deployment-file';
import {
  ONCHAIN_STATUS_KEY,
  deploymentId,
  type Deployment,
  type IndexerStatus,
  type KeeperStatus,
  type OnchainStatus,
  type RelayerStatus,
  type RoleHealth,
} from '@velum/config/src/onchain';
import type { PrismaClient } from '@velum/db';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PublicClient } from 'viem';
import type { Logger } from '../lib/log';
import { publicClientFor } from './chain';
import type { OnchainEnv } from './env';
import { describeError } from './errors';
import { Indexer } from './indexer';
import { roleLock, type RoleLock } from './lock';

export const ONCHAIN_QUEUES = { relay: 'velum-onchain-relay', keeper: 'velum-onchain-keeper', indexer: 'velum-onchain-indexer' } as const;
/** How often the status for /v1/health is written; it expires if the workers stop writing it. */
export const STATUS_EVERY_MS = 5000;
const STATUS_TTL_S = 120;
/** A role whose last successful tick is older than max(this, 10 ticks) gets its job scheduler re-added (once a minute). */
const SCHEDULER_HEAL_AFTER_MS = 60_000;

export const REDIS_SOCKET_REQUIRED =
  "REDIS_URL is not a unix socket: the on-chain workers run only on Velum's own Redis (deploy/redis-velum.sh, socket /run/velum-redis/redis.sock), never on a shared one whose tenants could hold their locks or delete their schedulers";

export interface StartOnchainOptions {
  env: OnchainEnv;
  chainId: number;
  rpcUrl: string;
  prisma: PrismaClient;
  /** BullMQ connection (maxRetriesPerRequest: null) and status writer; must connect over a unix socket. */
  redis: Redis;
  mac: CacheMac;
  log: Logger;
  /** Clock for the session calendar and snapshot ages (the end-to-end test injects one). */
  now?: () => number;
  /** Test overrides. */
  client?: PublicClient;
  deployment?: Deployment;
}

export interface OnchainHandle {
  deployment: Deployment;
  indexer: Indexer;
  status(): OnchainStatus;
  /** Write the status to Redis now (also done every STATUS_EVERY_MS). */
  writeStatus(): Promise<void>;
  stop(): Promise<void>;
}

const offSender = (error: string | null): RelayerStatus & KeeperStatus => ({
  enabled: false,
  address: null,
  sending: false,
  balanceWei: null,
  balanceLow: false,
  inflight: false,
  stuck: false,
  gasCapped: false,
  lastTx: null,
  lastConfirmedAt: null,
  error,
  alerts: [],
  lastPushAt: null,
  lastPushBlockTime: null,
  sequencerUp: null,
  markets: {},
  lastRunAt: null,
  liquidations: 0,
  forcedExits: 0,
  fundingAdvances: 0,
  coverPayouts: 0,
});

/** Why the on-chain workers may not use this Redis connection (audit M-3), or null: it must be a unix socket. */
export function redisRefusal(redis: { options?: { path?: string | null } }): string | null {
  return typeof redis.options?.path === 'string' && redis.options.path.length > 0 ? null : REDIS_SOCKET_REQUIRED;
}

/** The status written while the on-chain workers are disabled although ONCHAIN_WORKERS=true (I-2, M-3). */
export function disabledStatus(chainId: number, reason: string, startedAt: number, now = Date.now()): OnchainStatus {
  const off: RoleHealth = { enabled: false, lockHeld: null, lastOkAt: null, everyMs: 0 };
  return {
    v: 1,
    at: now,
    chainId,
    deployment: '',
    indexer: { enabled: false, block: null, head: null, lagBlocks: null, lastRunAt: null, reorgs: 0, error: null },
    relayer: offSender(null),
    keeper: offSender(null),
    startedAt,
    error: reason.slice(0, 500),
    roles: { relayer: off, keeper: off, indexer: off },
  };
}

/**
 * Writes the disabled status every STATUS_EVERY_MS (it expires otherwise), so /v1/health says why the on-chain
 * workers are off while the Phase 2 workers run on (I-2, M-3). Returns a stop function.
 */
export function startDisabledStatus(o: { redis: Pick<Redis, 'set'>; mac: CacheMac; chainId: number; reason: string; log: Logger }): () => void {
  const startedAt = Date.now();
  const write = () =>
    void o.redis.set(ONCHAIN_STATUS_KEY, o.mac.seal(ONCHAIN_STATUS_KEY, JSON.stringify(disabledStatus(o.chainId, o.reason, startedAt))), 'EX', STATUS_TTL_S).catch((err: unknown) =>
      o.log.warn('on-chain status write failed', { err: describeError(err) }),
    );
  write();
  const timer = setInterval(write, STATUS_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The deployment the on-chain workers should run against, or null (with the reason logged). */
export function onchainDeployment(env: OnchainEnv, chainId: number, log: Logger): Deployment | null {
  if (!env.requested) {
    log.info('on-chain workers off (ONCHAIN_WORKERS is not true)');
    return null;
  }
  const read = readDeploymentFile(env.deploymentsDir, chainId);
  if (read.status === 'missing') {
    log.info('on-chain workers off: no deployment file for this chain', { chainId, path: read.path });
    return null;
  }
  if (read.status === 'invalid') {
    log.error('on-chain workers off: the deployment file is invalid', { chainId, path: read.path, err: read.error });
    return null;
  }
  return read.deployment;
}

async function removeScheduler(redis: Redis, name: string): Promise<void> {
  const q = new Queue(name, { connection: redis });
  try {
    await q.removeJobScheduler(`${name}-tick`);
  } finally {
    await q.close();
  }
}

/**
 * Removes the on-chain job schedulers a previous run left in Redis (the workers are off now), so no job is
 * added to a queue nobody serves.
 */
export async function removeOnchainSchedulers(redis: Redis): Promise<void> {
  for (const name of Object.values(ONCHAIN_QUEUES)) await removeScheduler(redis, name);
}

export async function startOnchain(o: StartOnchainOptions): Promise<OnchainHandle | null> {
  const deployment = o.deployment ?? onchainDeployment(o.env, o.chainId, o.log);
  if (!deployment) return null;
  const refusedRedis = redisRefusal(o.redis);
  if (refusedRedis) {
    o.log.error('on-chain workers off', { reason: refusedRedis });
    return null;
  }
  const { env, chainId, log, prisma, redis } = o;
  const startedAt = Date.now();
  const client = o.client ?? publicClientFor(chainId, o.rpcUrl);
  const indexer = new Indexer({ client, prisma, deployment, chainId, confirmations: env.confirmations, chunkBlocks: env.chunkBlocks, startBlock: env.startBlock, log });

  const id = deploymentId(deployment);
  type Role = 'indexer';
  const locks: Record<Role, RoleLock> = { indexer: roleLock(redis, `indexer:${chainId}:${id}`) };
  const lockHeld: Record<Role, boolean | null> = { indexer: null };

  const defaultJobOptions = { removeOnComplete: true, removeOnFail: 100 } as const;
  const queues: Array<{ role: Role; q: Queue; name: string; every: number; healedAt: number }> = [];
  const workers: Worker[] = [];
  const add = async (role: Role, name: string, every: number, run: () => Promise<void>, lock: RoleLock) => {
    const q = new Queue(name, { connection: redis, defaultJobOptions });
    await q.upsertJobScheduler(`${name}-tick`, { every }, { name: 'tick', opts: defaultJobOptions });
    queues.push({ role, q, name, every, healedAt: 0 });
    // A job's payload is never read: each tick works from the chain and Postgres (audit M-2).
    const w = new Worker(
      name,
      async () => {
        const held = await lock.hold();
        lockHeld[role] = held;
        if (!held) return;
        await run();
      },
      { connection: redis, concurrency: 1 },
    );
    w.on('failed', (job, err) => log.error('on-chain job failed', { queue: name, err: err.message }));
    w.on('error', (err) => log.error('on-chain worker error', { queue: name, err: err.message }));
    workers.push(w);
  };

  try {
    // The relayer and keeper run in velum-signer: their schedulers from an older release are removed.
    await removeScheduler(redis, ONCHAIN_QUEUES.relay);
    await removeScheduler(redis, ONCHAIN_QUEUES.keeper);
    await add('indexer', ONCHAIN_QUEUES.indexer, env.indexerPollMs, () => indexer.tick(), locks.indexer);
  } catch (err) {
    // Leave nothing half-started: the caller retries the whole start.
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled(queues.map((x) => x.q.close()));
    throw err;
  }

  const roleHealth = (role: Role, enabled: boolean, lastOkAt: number | null, everyMs: number): RoleHealth => ({ enabled, lockHeld: enabled ? lockHeld[role] : null, lastOkAt, everyMs });
  const status = (): OnchainStatus => {
    const idx: IndexerStatus = indexer.status(true);
    return {
      v: 1,
      at: Date.now(),
      chainId,
      deployment: id,
      indexer: idx,
      // The relayer and the keeper report from velum-signer (its status file); the API combines both.
      relayer: offSender(null),
      keeper: offSender(null),
      startedAt,
      error: null,
      pushIntervalMs: env.relayIntervalMs,
      roles: {
        relayer: { enabled: false, lockHeld: null, lastOkAt: null, everyMs: 0 },
        keeper: { enabled: false, lockHeld: null, lastOkAt: null, everyMs: 0 },
        indexer: roleHealth('indexer', true, indexer.lastOkAt, env.indexerPollMs),
      },
    };
  };
  const lastOk: Record<Role, () => number | null> = { indexer: () => indexer.lastOkAt };
  /**
   * Refreshes the lock flags from Redis (read only) and re-adds the job scheduler of a role whose last successful
   * tick is overdue (a scheduler someone deleted), at most once a minute per role.
   */
  const checkRoles = async () => {
    const now = Date.now();
    for (const x of queues) {
      // Only once the role's job ran (before that it has not tried to take the lock yet).
      if (lockHeld[x.role] !== null) lockHeld[x.role] = await locks[x.role].owned().catch(() => lockHeld[x.role]);
      const last = lastOk[x.role]() ?? startedAt;
      if (now - last > Math.max(SCHEDULER_HEAL_AFTER_MS, 10 * x.every) && now - x.healedAt > SCHEDULER_HEAL_AFTER_MS) {
        x.healedAt = now;
        await x.q.upsertJobScheduler(`${x.name}-tick`, { every: x.every }, { name: 'tick', opts: defaultJobOptions }).then(
          () => log.warn('on-chain role has not ticked for a while; re-added its job scheduler', { queue: x.name, sinceMs: now - last }),
          (err: unknown) => log.warn('on-chain job scheduler re-add failed', { queue: x.name, err: describeError(err) }),
        );
      }
    }
  };
  const writeStatus = async () => {
    await checkRoles().catch((err: unknown) => log.warn('on-chain role check failed', { err: describeError(err) }));
    await redis.set(ONCHAIN_STATUS_KEY, o.mac.seal(ONCHAIN_STATUS_KEY, JSON.stringify(status())), 'EX', STATUS_TTL_S).then(
      () => undefined,
      (err: unknown) => log.warn('on-chain status write failed', { err: describeError(err) }),
    );
  };
  await writeStatus();
  const timer = setInterval(() => void writeStatus(), STATUS_EVERY_MS);
  timer.unref?.();

  log.info('on-chain indexer started (the relayer and keeper run in velum-signer)', {
    chainId,
    deployment: id,
    indexerFrom: indexer.startBlock,
    confirmations: env.confirmations,
  });

  return {
    deployment,
    indexer,
    status,
    writeStatus,
    async stop() {
      clearInterval(timer);
      await Promise.allSettled(workers.map((w) => w.close()));
      await Promise.allSettled(queues.map((x) => x.q.close()));
      await Promise.allSettled(Object.values(locks).map((l) => l.release()));
    },
  };
}
