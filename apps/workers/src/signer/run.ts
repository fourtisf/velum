/**
 * The signer process (velum-signer; on-chain audit M-2): the price relayer and the keeper, the only code that holds the
 * hot keys, run here as their own Unix user, apart from the internet-facing API and the workers (the app user). It
 * reads nothing the app user can write:
 *  - keys from SIGNER_KEYS_FILE (root:<signer group> 640), never from an environment or .env;
 *  - prices straight from Robinhood's public API (prices.ts), never from Redis;
 *  - positions, forced exits and cover claims straight from the chain (keeper.ts), never from the indexer's database;
 *  - the deployment file from its own copy of the release (or a path only root and the signer control).
 * It uses no Redis and no Postgres. A compromised app user can at worst slow it down (load, the RPC both use), which
 * shows in /v1/health; it cannot make it sign. Gating is unchanged: nothing runs unless ONCHAIN_WORKERS=true and the
 * deployment file of CHAIN_ID exists, and nothing is signed for Robinhood Chain mainnet (4663) without
 * ONCHAIN_MAINNET_CONFIRMED=yes (tx-sender.ts checks it in every signing path).
 *
 * Scheduling: plain loops (the relayer every second, the keeper every KEEPER_INTERVAL_MS, the price read every 2 s), one
 * tick at a time each; one instance per user (lock.ts). The status (no secrets) goes to SIGNER_STATUS_FILE every 5 s.
 */
import path from 'node:path';
import { readDeploymentFile } from '@velum/config/src/deployment-file';
import {
  ONCHAIN_MAINNET_CHAIN_ID,
  SIGNER_STATUS_EVERY_MS,
  deploymentId,
  deploymentMarkets,
  type Deployment,
  type KeeperStatus,
  type RelayerStatus,
  type RoleHealth,
  type SignerStatus,
} from '@velum/config/src/onchain';
import { toDecimalString } from '@velum/math';
import type { PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Logger } from '../lib/log';
import { abis, publicClientFor } from '../onchain/chain';
import { describeError, throttledWarn } from '../onchain/errors';
import { Keeper } from '../onchain/keeper';
import { PriceRelayer } from '../onchain/relayer';
import { TxSender, type SendChain, type SenderChain } from '../onchain/tx-sender';
import { robinhoodSource } from '../sources/robinhood';
import type { SignerEnv } from './env';
import { StateDir, readKeysFile, untrustedPath, writeAtomic, type SignerKeys } from './files';
import { SignerPrices } from './prices';

/** The relay loop ticks every second (the push cadence itself is PRICE_PUSH_INTERVAL_MS). */
const RELAY_EVERY_MS = 1000;
/** The signer reads its quotes every 2 s (the relayer refuses a quote confirmed more than 6 s ago). */
export const PRICE_POLL_MS = 2000;

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
const offRole: RoleHealth = { enabled: false, lockHeld: null, lastOkAt: null, everyMs: 0 };

/** The status written while the signer runs neither role (not requested, or `error`). */
export function idleSignerStatus(o: { chainId: number; startedAt: number; requested: boolean; error: string | null; pushIntervalMs?: number; now?: number }): SignerStatus {
  return {
    v: 1,
    at: o.now ?? Date.now(),
    chainId: o.chainId,
    deployment: '',
    startedAt: o.startedAt,
    requested: o.requested,
    error: o.error === null ? null : o.error.slice(0, 500),
    pushIntervalMs: o.pushIntervalMs ?? 0,
    relayer: offSender(null),
    keeper: offSender(null),
    roles: { relayer: offRole, keeper: offRole },
    prices: { lastPollAt: null, markets: {} },
  };
}

/**
 * Writes `status` to `file` atomically (mode 640: the app user's group, which owns the directory's group, may read it;
 * nobody but the signer may write it). Errors are logged once a minute, never thrown.
 */
export function statusWriter(file: string, log: Logger): (s: SignerStatus) => void {
  const warn = throttledWarn(log);
  return (s) => {
    try {
      writeAtomic(file, JSON.stringify(s), 0o640);
    } catch (err) {
      warn('signer status write failed (is the status directory there? deploy/server-setup.sh creates it)', { file, err: describeError(err) });
    }
  };
}

/** The deployment file, read only from a path that root and the signer control (never one the app user can write). */
export function trustedDeployment(dir: string, chainId: number): { deployment: Deployment | null; error: string | null } {
  const file = path.join(dir, `${chainId}.json`);
  const read = readDeploymentFile(dir, chainId);
  if (read.status === 'missing') return { deployment: null, error: `no deployment file for chain ${chainId} (${file})` };
  const bad = untrustedPath(file);
  if (bad) return { deployment: null, error: `the deployment file is on a path another user can change (${bad}); the signer reads it only from its own copy of the release or a root-owned path` };
  if (read.status === 'invalid') return { deployment: null, error: `the deployment file is invalid: ${read.error}` };
  return { deployment: read.deployment, error: null };
}

export interface StartSignerOptions {
  env: SignerEnv;
  log: Logger;
  /** Test overrides. */
  fetchImpl?: typeof fetch;
  client?: PublicClient;
  sendClient?: PublicClient;
  deployment?: Deployment;
  keys?: SignerKeys;
  relayStuckAfterMs?: number;
  keeperStuckAfterMs?: number;
  /** Write the status file (default true). */
  writeFile?: boolean;
}

export interface SignerHandle {
  deployment: Deployment | null;
  relayer: PriceRelayer | null;
  keeper: Keeper | null;
  prices: SignerPrices | null;
  senders: { relay: TxSender | null; keeper: TxSender | null };
  status(): SignerStatus;
  /** Writes the status file now (also done every SIGNER_STATUS_EVERY_MS). */
  writeStatus(): void;
  stop(): Promise<void>;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** Starts the signer (after the caller took the instance lock). Never throws for bad settings: they go to the status. */
export async function startSigner(o: StartSignerOptions): Promise<SignerHandle> {
  const { env, log } = o;
  const startedAt = Date.now();
  const stop = new AbortController();
  const write = o.writeFile === false ? () => undefined : statusWriter(env.statusFile, log);
  const pushIntervalMs = env.onchain.relayIntervalMs;
  const chainId = env.chainId;
  if (env.envKeys.length) log.warn('hot keys found in the signer environment are ignored: the signer reads them only from SIGNER_KEYS_FILE', { names: env.envKeys.join(',') });

  // ── Not requested, or nothing to run against: report why, sign nothing ──
  const idle = (error: string | null, deployment: Deployment | null = null): SignerHandle => {
    const status = () => idleSignerStatus({ chainId, startedAt, requested: env.onchain.requested, error, pushIntervalMs });
    const writeStatus = () => write(status());
    writeStatus();
    const timer = setInterval(writeStatus, SIGNER_STATUS_EVERY_MS);
    return {
      deployment,
      relayer: null,
      keeper: null,
      prices: null,
      senders: { relay: null, keeper: null },
      status,
      writeStatus,
      async stop() {
        clearInterval(timer);
      },
    };
  };
  if (!env.onchain.requested) {
    log.info('signer idle (ONCHAIN_WORKERS is not true)');
    return idle(null);
  }
  let deployment = o.deployment ?? null;
  if (!deployment) {
    const t = trustedDeployment(env.deploymentsDir, chainId);
    if (!t.deployment) {
      log.info('signer idle', { reason: t.error });
      return idle(t.error);
    }
    deployment = t.deployment;
  }
  let state: StateDir;
  try {
    state = new StateDir(env.stateDir);
  } catch (err) {
    const msg = describeError(err);
    log.error('signer idle: its state directory is unusable', { err: msg });
    return idle(msg, deployment);
  }
  let keys = o.keys;
  let keyProblems: string[] = [];
  if (!keys) {
    const k = readKeysFile(env.keysFile);
    keys = k.keys;
    keyProblems = k.problems;
    for (const p of keyProblems) log.error('signer keys file problem', { problem: p });
  }

  // ── The roles ──
  const now = () => Date.now() + env.test.clockOffsetMs;
  const client = o.client ?? publicClientFor(chainId, env.rpcUrl);
  const chain = client as unknown as SenderChain;
  const sendUrl = env.onchain.sendRpcUrl();
  const send = (o.sendClient ?? (sendUrl ? publicClientFor(chainId, sendUrl) : undefined)) as unknown as SendChain | undefined;
  const mainnetLocked = chainId === ONCHAIN_MAINNET_CHAIN_ID && !env.onchain.mainnetConfirmed;
  if (mainnetLocked) log.warn('Robinhood Chain mainnet without ONCHAIN_MAINNET_CONFIRMED=yes: the relayer and keeper only read');
  const keyError = (name: string) => keyProblems.find((p) => p.startsWith(name) || p.includes(` ${name} `)) ?? keyProblems.find((p) => p.startsWith('SIGNER_KEYS_FILE')) ?? `${name} not set in SIGNER_KEYS_FILE`;

  const relayKey = keys.relay();
  const keeperKey = keys.keeper();
  let relayer: PriceRelayer | null = null;
  let keeper: Keeper | null = null;
  let prices: SignerPrices | null = null;
  let relaySender: TxSender | null = null;
  let keeperSender: TxSender | null = null;
  let keeperError: string | null = keeperKey ? null : keyError('KEEPER_PRIVATE_KEY');
  const relayError: string | null = relayKey ? null : keyError('PRICE_RELAY_PRIVATE_KEY');
  if (relayKey) {
    relaySender = new TxSender(chain, privateKeyToAccount(relayKey), {
      role: 'relayer',
      chainId,
      maxFeeWei: env.onchain.relayMaxFeeWei,
      minBalanceWei: env.onchain.relayMinBalanceWei,
      mainnetConfirmed: env.onchain.mainnetConfirmed,
      stuckAfterMs: o.relayStuckAfterMs ?? 6000,
      log,
      send,
    });
    const symbols = deploymentMarkets(deployment);
    const source = robinhoodSource(log, o.fetchImpl ?? fetch, { symbols, pricesUrl: env.test.pricesUrl ?? undefined, assetsUrl: env.test.assetsUrl ?? undefined });
    prices = new SignerPrices({ source, symbols, state: state.store('last-quotes'), log, now });
    relayer = new PriceRelayer({ client, sender: relaySender, prices, deployment, chainId, intervalMs: pushIntervalMs, log, now });
  } else log.warn('price relayer off', { reason: relayError });
  if (keeperKey) {
    const account = privateKeyToAccount(keeperKey);
    if (deployment.priceRelayer && account.address.toLowerCase() === deployment.priceRelayer) {
      keeperError = 'KEEPER_PRIVATE_KEY is the price-relay key: create a separate one';
      log.error('keeper off: its key is the price-relay key');
    } else {
      keeperSender = new TxSender(chain, account, {
        role: 'keeper',
        chainId,
        maxFeeWei: env.onchain.keeperMaxFeeWei,
        minBalanceWei: env.onchain.keeperMinBalanceWei,
        mainnetConfirmed: env.onchain.mainnetConfirmed,
        stuckAfterMs: o.keeperStuckAfterMs ?? 15_000,
        log,
        send,
      });
      keeper = new Keeper({
        client,
        sender: keeperSender,
        deployment,
        chainId,
        fundingEpochSeconds: env.onchain.fundingEpochSeconds,
        ethPriceUsd: env.onchain.ethPriceUsd,
        maxFeeWei: env.onchain.keeperMaxFeeWei,
        confirmations: env.onchain.confirmations,
        chunkBlocks: env.onchain.chunkBlocks,
        state: state.store('keeper-cover'),
        log,
      });
    }
  } else log.warn('keeper off', { reason: keeperError });

  // Each sender verifies the RPC chain id and adopts pending transactions on its first tick; a sender that could not
  // initialise (RPC down) is retried every 10 s, with one warning a minute.
  const initialized = new WeakSet<TxSender>();
  const initRetryAt = new WeakMap<TxSender, number>();
  const warn = throttledWarn(log);
  const ready = async (s: TxSender): Promise<boolean> => {
    if (initialized.has(s) && s.refusal() !== 'RPC chain id not verified yet') return true;
    if ((initRetryAt.get(s) ?? 0) > Date.now()) return false;
    try {
      await s.init();
      initialized.add(s);
      return true;
    } catch (err) {
      initRetryAt.set(s, Date.now() + 10_000);
      warn('sender init failed', { err: describeError(err) });
      return false;
    }
  };

  // The jump guard's reference for a market with no saved quote: the price last relayed on chain (best effort).
  const seedReferences = async () => {
    if (!prices || !relayer) return;
    const missing = new Set(prices.unseeded());
    for (const { symbol, token } of relayer.tokens) {
      if (!missing.has(symbol)) continue;
      try {
        const [p] = (await client.readContract({ address: deployment.contracts.oracle, abi: abis.oracle, functionName: 'relayed', args: [token] })) as readonly [bigint, bigint, bigint];
        if (p > 0n) prices.setReference(symbol, toDecimalString(p));
      } catch {
        /* retried on the next poll */
      }
    }
  };

  const loops: Promise<void>[] = [];
  const loop = (everyMs: number, fn: () => Promise<void>) => {
    loops.push(
      (async () => {
        while (!stop.signal.aborted) {
          const t = Date.now();
          await fn().catch((err: unknown) => warn('signer loop error', { err: describeError(err) }));
          await sleep(Math.max(50, everyMs - (Date.now() - t)), stop.signal);
        }
      })(),
    );
  };
  if (prices) {
    const p = prices;
    loop(PRICE_POLL_MS, async () => {
      if (p.unseeded().length && relayer?.tokens.length) await seedReferences();
      await p.poll();
    });
  }
  if (relayer && relaySender) {
    const r = relayer;
    const s = relaySender;
    loop(RELAY_EVERY_MS, async () => {
      if (await ready(s)) await r.tick();
    });
  }
  if (keeper && keeperSender) {
    const k = keeper;
    const s = keeperSender;
    loop(env.onchain.keeperIntervalMs, async () => {
      if (await ready(s)) await k.tick();
    });
  }

  const id = deploymentId(deployment);
  const role = (enabled: boolean, lastOkAt: number | null, everyMs: number): RoleHealth => ({ enabled, lockHeld: enabled ? true : null, lastOkAt, everyMs });
  const status = (): SignerStatus => ({
    v: 1,
    at: Date.now(),
    chainId,
    deployment: id,
    startedAt,
    requested: true,
    error: relayer || keeper ? null : [relayError, keeperError].filter(Boolean).join('; ').slice(0, 500) || 'neither role can run',
    pushIntervalMs,
    relayer: relayer ? relayer.status() : offSender(relayError),
    keeper: keeper ? keeper.status() : offSender(keeperError),
    roles: { relayer: role(relayer !== null, relayer?.lastOkAt ?? null, RELAY_EVERY_MS), keeper: role(keeper !== null, keeper?.lastOkAt ?? null, env.onchain.keeperIntervalMs) },
    prices: prices ? prices.status() : { lastPollAt: null, markets: {} },
  });
  const writeStatus = () => write(status());
  writeStatus();
  const timer = setInterval(writeStatus, SIGNER_STATUS_EVERY_MS);

  log.info('signer started', {
    chainId,
    deployment: id,
    relayer: relaySender?.address ?? null,
    keeper: keeperSender?.address ?? null,
    markets: deploymentMarkets(deployment).join(','),
    mainnetLocked,
    sendEndpoint: send ? 'RPC_URL_SEND' : 'RPC_URL',
  });

  return {
    deployment,
    relayer,
    keeper,
    prices,
    senders: { relay: relaySender, keeper: keeperSender },
    status,
    writeStatus,
    async stop() {
      clearInterval(timer);
      stop.abort();
      await Promise.allSettled(loops);
    },
  };
}
