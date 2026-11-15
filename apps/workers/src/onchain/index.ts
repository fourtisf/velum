/**
 * Starts the Phase 3 on-chain workers inside the workers process: the price relayer, the keeper and the
 * indexer, each on its own BullMQ queue (one job at a time) behind a Redis role lock (one active instance),
 * plus the status the API reports in /v1/health. Off unless ONCHAIN_WORKERS=true and the deployment file of
 * the chain exists; the relayer needs PRICE_RELAY_PRIVATE_KEY, the keeper KEEPER_PRIVATE_KEY (separate keys);
 * on Robinhood Chain mainnet neither sends anything without ONCHAIN_MAINNET_CONFIRMED=yes (they only read).
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
  ONCHAIN_MAINNET_CHAIN_ID,
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
import { privateKeyToAccount } from 'viem/accounts';
import type { Logger } from '../lib/log';
import { publicClientFor } from './chain';
import type { OnchainEnv } from './env';
import { describeError, throttledWarn } from './errors';
import { Indexer } from './indexer';
import { Keeper } from './keeper';
import { roleLock, type RoleLock } from './lock';
import { PriceRelayer } from './relayer';
import { TxSender, type SendChain, type SenderChain } from './tx-sender';

export const ONCHAIN_QUEUES = { relay: 'velum-onchain-relay', keeper: 'velum-onchain-keeper', indexer: 'velum-onchain-indexer' } as const;
/** How often the status for /v1/health is written; it expires if the workers stop writing it. */
export const STATUS_EVERY_MS = 5000;
const STATUS_TTL_S = 120;
/** The relay queue ticks every second. */
const RELAY_EVERY_MS = 1000;
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
  sendClient?: PublicClient;
  relayStuckAfterMs?: number;
  keeperStuckAfterMs?: number;
  deployment?: Deployment;
}

export interface OnchainHandle {
  deployment: Deployment;
  relayer: PriceRelayer | null;
  keeper: Keeper | null;
  indexer: Indexer;
  senders: { relay: TxSender | null; keeper: TxSender | null };
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
  const chain = client as unknown as SenderChain;
  // RPC_URL_SEND (audit M-1): broadcasts, nonces and receipts through a trusted endpoint when one is set.
  const sendUrl = env.sendRpcUrl();
  const send = (o.sendClient ?? (sendUrl ? publicClientFor(chainId, sendUrl) : undefined)) as unknown as SendChain | undefined;
  const mainnetLocked = chainId === ONCHAIN_MAINNET_CHAIN_ID && !env.mainnetConfirmed;
  if (mainnetLocked) log.warn('Robinhood Chain mainnet without ONCHAIN_MAINNET_CONFIRMED=yes: the relayer and keeper only read; the indexer runs');

  // Keys become viem accounts here and nowhere else (the key stays in the account's closure).
  const relayKey = env.keys.relay();
  const keeperKey = env.keys.keeper();
  let relayer: PriceRelayer | null = null;
  let keeper: Keeper | null = null;
  let relaySender: TxSender | null = null;
  let keeperSender: TxSender | null = null;
  let keeperError: string | null = keeperKey ? null : 'KEEPER_PRIVATE_KEY not set';
  if (relayKey) {
    // Each sender verifies the RPC chain id and adopts pending transactions on its first tick (ensureInit
    // below), so an RPC outage never delays the start of the workers process.
    const sender = (relaySender = new TxSender(chain, privateKeyToAccount(relayKey), {
      role: 'relayer',
      chainId,
      maxFeeWei: env.relayMaxFeeWei,
      minBalanceWei: env.relayMinBalanceWei,
      mainnetConfirmed: env.mainnetConfirmed,
      stuckAfterMs: o.relayStuckAfterMs ?? 6000,
      log,
      send,
    }));
    relayer = new PriceRelayer({ client, sender, redis, mac: o.mac, deployment, chainId, intervalMs: env.relayIntervalMs, log, now: o.now });
  } else log.warn('price relayer off: PRICE_RELAY_PRIVATE_KEY not set');
  if (keeperKey) {
    const account = privateKeyToAccount(keeperKey);
    if (deployment.priceRelayer && account.address.toLowerCase() === deployment.priceRelayer) {
      keeperError = 'KEEPER_PRIVATE_KEY is the price-relay key: create a separate one';
      log.error('keeper off: its key is the price-relay key');
    } else {
      const sender = (keeperSender = new TxSender(chain, account, {
        role: 'keeper',
        chainId,
        maxFeeWei: env.keeperMaxFeeWei,
        minBalanceWei: env.keeperMinBalanceWei,
        mainnetConfirmed: env.mainnetConfirmed,
        stuckAfterMs: o.keeperStuckAfterMs ?? 15_000,
        log,
        send,
      }));
      keeper = new Keeper({ client, sender, prisma, deployment, chainId, fundingEpochSeconds: env.fundingEpochSeconds, ethPriceUsd: env.ethPriceUsd, maxFeeWei: env.keeperMaxFeeWei, log });
    }
  } else log.warn('keeper off: KEEPER_PRIVATE_KEY not set');
  const indexer = new Indexer({ client, prisma, deployment, chainId, confirmations: env.confirmations, chunkBlocks: env.chunkBlocks, startBlock: env.startBlock, log });

  const initialized = new WeakSet<TxSender>();
  const ensureInit = async (s: TxSender) => {
    if (initialized.has(s) && s.refusal() !== 'RPC chain id not verified yet') return;
    await s.init();
    initialized.add(s);
  };

  const id = deploymentId(deployment);
  type Role = 'relay' | 'keeper' | 'indexer';
  const locks: Record<Role, RoleLock> = {
    relay: roleLock(redis, `relayer:${chainId}:${id}`),
    keeper: roleLock(redis, `keeper:${chainId}:${id}`),
    indexer: roleLock(redis, `indexer:${chainId}:${id}`),
  };
  const lockHeld: Record<Role, boolean | null> = { relay: null, keeper: null, indexer: null };

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

  // A sender that could not initialise (RPC down) is retried every 10 s, with one warning a minute.
  const warn = throttledWarn(log);
  const initRetryAt = new WeakMap<TxSender, number>();
  const tickWith = (component: { tick(): Promise<void> }, sender: TxSender | null) => async () => {
    if (sender) {
      if ((initRetryAt.get(sender) ?? 0) > Date.now()) return;
      try {
        await ensureInit(sender);
      } catch (err) {
        initRetryAt.set(sender, Date.now() + 10_000);
        warn('sender init failed', { err: describeError(err) });
        return;
      }
    }
    await component.tick();
  };
  try {
    if (relayer) await add('relay', ONCHAIN_QUEUES.relay, RELAY_EVERY_MS, tickWith(relayer, relaySender), locks.relay);
    else await removeScheduler(redis, ONCHAIN_QUEUES.relay);
    if (keeper) await add('keeper', ONCHAIN_QUEUES.keeper, env.keeperIntervalMs, tickWith(keeper, keeperSender), locks.keeper);
    else await removeScheduler(redis, ONCHAIN_QUEUES.keeper);
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
      relayer: relayer ? relayer.status() : offSender(relayKey ? null : 'PRICE_RELAY_PRIVATE_KEY not set'),
      keeper: keeper ? keeper.status() : offSender(keeperError),
      startedAt,
      error: null,
      pushIntervalMs: env.relayIntervalMs,
      roles: {
        relayer: roleHealth('relay', relayer !== null, relayer?.lastOkAt ?? null, RELAY_EVERY_MS),
        keeper: roleHealth('keeper', keeper !== null, keeper?.lastOkAt ?? null, env.keeperIntervalMs),
        indexer: roleHealth('indexer', true, indexer.lastOkAt, env.indexerPollMs),
      },
    };
  };
  const lastOk: Record<Role, () => number | null> = { relay: () => relayer?.lastOkAt ?? null, keeper: () => keeper?.lastOkAt ?? null, indexer: () => indexer.lastOkAt };
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

  log.info('on-chain workers started', {
    chainId,
    deployment: id,
    relayer: relaySender?.address ?? null,
    keeper: keeperSender?.address ?? null,
    indexerFrom: indexer.startBlock,
    confirmations: env.confirmations,
    mainnetLocked,
    sendEndpoint: send ? 'RPC_URL_SEND' : 'RPC_URL',
  });

  return {
    deployment,
    relayer,
    keeper,
    indexer,
    senders: { relay: relaySender, keeper: keeperSender },
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
