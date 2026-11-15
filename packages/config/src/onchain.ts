/**
 * Phase 3 on-chain constants, the deployment file contract and the on-chain workers' status payload.
 * Pure and dependency-free (no node:*, no viem): import it as '@velum/config/src/onchain' from apps/api and
 * apps/workers. It is not re-exported from index.ts, so the web bundle never pulls it in.
 *
 * The contract numbers below mirror contracts/src (OracleAdapter, PerpsBase). A test in apps/workers reads the
 * Solidity sources and fails when they drift (onchain/constants.test.ts).
 */
import { MAINNET_CHAIN_ID } from './index';

export type Hex = `0x${string}`;
/** A 20-byte address in lower case: the form every Velum table and comparison uses (the API checksums output). */
export type LowerAddress = Hex;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const ZERO_ADDRESS: LowerAddress = '0x0000000000000000000000000000000000000000';

/** Lower-case form of a 0x address, or null when `v` is not one (any letter case accepted). */
export function lowerAddress(v: unknown): LowerAddress | null {
  return typeof v === 'string' && ADDRESS_RE.test(v) ? (v.toLowerCase() as LowerAddress) : null;
}

/** Robinhood Chain mainnet. The on-chain workers never send a transaction there without ONCHAIN_MAINNET_CONFIRMED=yes. */
export const ONCHAIN_MAINNET_CHAIN_ID = MAINNET_CHAIN_ID;
/** The local anvil chain the end-to-end test and `forge script` use. */
export const ANVIL_CHAIN_ID = 31337;

/** contracts/src/OracleAdapter.sol and contracts/src/perps/PerpsBase.sol (checked against the sources by a test). */
export const ORACLE_LIMITS = {
  /** MAX_MOVE_BPS: at most 5% per recording. */
  maxMoveBps: 500n,
  /** MOVE_WINDOW: the allowance grows linearly up to 5 minutes since the rate-limit clock (1/6000 per second). */
  moveWindowSeconds: 300n,
  bps: 10_000n,
  /** MAX_AGE / MAX_PRICE_AGE: closes, liquidations and funding need a price at most 60 s old. */
  maxAgeSeconds: 60,
  /** OPEN_MAX_AGE: opens, margin removal and forced-exit settlement need a price at most 10 s old. */
  openMaxAgeSeconds: 10,
  /**
   * MAX_PUSH_DELAY: a relay push must land at most 10 s after the observation time it carries, and that time is the
   * prices' source timestamp (on-chain workers audit M-1).
   */
  maxPushDelaySeconds: 10,
} as const;

/** contracts/src/perps/PerpsBase.sol. */
export const PERPS_LIMITS = {
  /** MM_BPS: maintenance margin, 10% of notional at 5x. */
  maintenanceBps: 1000n,
  /** LIQUIDATION_PENALTY_BPS: 1% of notional, half to the liquidator. */
  penaltyBps: 100n,
  /** FORCED_EXIT_DELAY. */
  forcedExitDelaySeconds: 7 * 24 * 3600,
  /** COVER_EPOCH. */
  coverEpochSeconds: 3600,
} as const;

/**
 * Price-relay cadence (contracts/README.md "The rate-limit clock"): pushes every 8 to 10 s keep opens possible
 * (they need a price at most 10 s old) while every push gets 8-10 s of rate-limit allowance.
 */
export const RELAY_INTERVAL_MS = { min: 8000, max: 10_000, default: 9000 } as const;
/**
 * While deferring a push the rate limit would clamp, the relay never lets the observation of its last push on
 * chain get older than this (seconds). Past it, it pushes the true price anyway so the on-chain price converges
 * (lagging). A deferral only waits for a move that fits the allowance by then, so the on-chain price trails the
 * market by at most 12 s x 1/6000 = 0.2% of price meanwhile: the residual extra exit option a closing taker
 * (60 s prices) can have, about 2.5x the minimum close cost (2 bps spread + 6 bps fee). Opens and margin removal
 * need a price at most 10 s old, so for them a deferral costs at most 2 s without a fresh price and no option
 * (on-chain workers audit L-5; it was 15 s, 0.25%).
 */
export const RELAY_MAX_PUSH_GAP_S = 12;
/**
 * A price snapshot the price-relay job confirmed with its source longer ago than this is never pushed. Its age is
 * subtracted from the push's observation time, which must be at most MAX_PUSH_DELAY (10 s) old when the push lands,
 * so this leaves 4 s for the clock estimate and inclusion (M-1). price-relay confirms every PRICE_POLL_MS (2 s).
 */
export const RELAY_SNAPSHOT_MAX_AGE_MS = 6_000;

/** Contracts every Phase 3 deployment file names (contracts/script/Deploy.s.sol `_write`). */
export const REQUIRED_CONTRACTS = ['vault', 'oracle', 'spotPools', 'makerBook', 'perpsMarkets'] as const;
export type CoreContract = (typeof REQUIRED_CONTRACTS)[number];

/** contracts/deployments/<chainId>.json as Deploy.s.sol writes it, validated, addresses in lower case. */
export interface Deployment {
  chainId: number;
  /** Block the deploy script simulated against: at or before the first deployment transaction. */
  startBlock: number;
  /** The five core contracts, plus any other address entry the file names (e.g. a later allowlist contract). */
  contracts: Record<CoreContract, LowerAddress> & Record<string, LowerAddress>;
  /** Symbol -> token address; USDG is the quote token, every other entry is a market. */
  tokens: Record<string, LowerAddress>;
  priceRelayer: LowerAddress | null;
  guardian: LowerAddress | null;
}

export type DeploymentParse = { ok: true; deployment: Deployment } | { ok: false; error: string };

const SYMBOL_RE = /^[A-Z][A-Z0-9]{0,11}$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_ENTRIES = 64;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validates a parsed deployment file for `chainId`. Unknown top-level keys are ignored; extra entries under
 * `contracts` are kept when they are addresses (a later contract such as an allowlist), so a newer deploy
 * script never breaks the readers. Returns an error naming the first problem.
 */
export function parseDeployment(raw: unknown, chainId: number): DeploymentParse {
  if (!isRecord(raw)) return { ok: false, error: 'not a JSON object' };
  if (raw.chainId !== chainId) return { ok: false, error: `chainId ${String(raw.chainId)} does not match ${chainId}` };
  const startBlock = raw.startBlock;
  if (typeof startBlock !== 'number' || !Number.isSafeInteger(startBlock) || startBlock < 0) return { ok: false, error: 'startBlock must be a non-negative integer' };
  if (!isRecord(raw.contracts) || !isRecord(raw.tokens)) return { ok: false, error: 'contracts and tokens must be objects' };
  if (Object.keys(raw.contracts).length > MAX_ENTRIES || Object.keys(raw.tokens).length > MAX_ENTRIES) return { ok: false, error: 'too many entries' };

  const contracts: Record<string, LowerAddress> = {};
  for (const [name, v] of Object.entries(raw.contracts)) {
    const a = lowerAddress(v);
    if (!NAME_RE.test(name) || !a || a === ZERO_ADDRESS) {
      if ((REQUIRED_CONTRACTS as readonly string[]).includes(name)) return { ok: false, error: `contracts.${name} is not an address` };
      continue;
    }
    contracts[name] = a;
  }
  for (const name of REQUIRED_CONTRACTS) if (!contracts[name]) return { ok: false, error: `contracts.${name} is missing` };
  const core = new Set(REQUIRED_CONTRACTS.map((n) => contracts[n]));
  if (core.size !== REQUIRED_CONTRACTS.length) return { ok: false, error: 'two core contracts share an address' };

  const tokens: Record<string, LowerAddress> = {};
  for (const [sym, v] of Object.entries(raw.tokens)) {
    const a = lowerAddress(v);
    if (!SYMBOL_RE.test(sym) || !a || a === ZERO_ADDRESS) return { ok: false, error: `tokens.${sym} is not a symbol and address` };
    tokens[sym] = a;
  }
  if (!tokens.USDG) return { ok: false, error: 'tokens.USDG is missing' };
  if (new Set(Object.values(tokens)).size !== Object.keys(tokens).length) return { ok: false, error: 'two tokens share an address' };

  const optional = (v: unknown): LowerAddress | null => {
    const a = lowerAddress(v);
    return a && a !== ZERO_ADDRESS ? a : null;
  };
  return {
    ok: true,
    deployment: {
      chainId,
      startBlock,
      contracts: contracts as Deployment['contracts'],
      tokens,
      priceRelayer: optional(raw.priceRelayer),
      guardian: optional(raw.guardian),
    },
  };
}

/** Market symbols of a deployment (every token but USDG), sorted. */
export const deploymentMarkets = (d: Deployment): string[] => Object.keys(d.tokens).filter((s) => s !== 'USDG').sort();

/** The address that identifies a deployment in the indexer tables (its perps engine). */
export const deploymentId = (d: Deployment): LowerAddress => d.contracts.perpsMarkets;

// ---------------------------------------------------------------- status (workers -> Redis -> API)

/** Redis key of the on-chain workers' status (authenticated like every value the API trusts, cache-mac.ts). */
export const ONCHAIN_STATUS_KEY = 'velum:onchain:status';
/** Raw JSON larger than this is never parsed. */
export const MAX_ONCHAIN_STATUS_BYTES = 16 * 1024;

export interface SenderStatus {
  enabled: boolean;
  /** Public address of the hot key (never the key). */
  address: string | null;
  /** False on mainnet without ONCHAIN_MAINNET_CONFIRMED=yes: the component only reads. */
  sending: boolean;
  balanceWei: string | null;
  balanceLow: boolean;
  inflight: boolean;
  stuck: boolean;
  gasCapped: boolean;
  lastTx: string | null;
  /** Unix ms of the last confirmed transaction. */
  lastConfirmedAt: number | null;
  error: string | null;
  /**
   * Conditions an operator must act on, each a short redacted sentence (on-chain workers audit M-1, L-4, L-7): a nonce
   * that stays unused after the replacements stopped, a failed nonce-gap fill, reverted pushes, a price outside the
   * oracle bounds. Any alert makes /v1/health `onchain.ok` false. Absent in a status written by an older release.
   */
  alerts?: string[];
}

/** How one on-chain role (relayer, keeper, indexer) is doing in this process (audit M-3). */
export interface RoleHealth {
  /** The role runs in this process (its key is set, or the indexer). */
  enabled: boolean;
  /** This process holds the role's Redis lock now (null: role off, or not checked yet). */
  lockHeld: boolean | null;
  /** Unix ms of the last tick that held the lock and ran to the end without an error. */
  lastOkAt: number | null;
  /** How often the role ticks (ms). */
  everyMs: number;
}

export interface RelayerStatus extends SenderStatus {
  /** Unix ms (wall clock) of the last confirmed push. */
  lastPushAt: number | null;
  /** Block time (s) of the last confirmed push. */
  lastPushBlockTime: number | null;
  sequencerUp: boolean | null;
  /** symbol -> "pushed" | "deferred" | "lagging" | a skip reason ("demo", "stale", "closed", ...). */
  markets: Record<string, string>;
}

export interface KeeperStatus extends SenderStatus {
  lastRunAt: number | null;
  liquidations: number;
  forcedExits: number;
  fundingAdvances: number;
  coverPayouts: number;
}

export interface IndexerStatus {
  enabled: boolean;
  block: number | null;
  head: number | null;
  lagBlocks: number | null;
  lastRunAt: number | null;
  reorgs: number;
  error: string | null;
}

export interface OnchainStatus {
  v: 1;
  /** Unix ms when the workers wrote this. */
  at: number;
  chainId: number;
  /** The deployment's perps address; empty while the on-chain workers are disabled (`error`). */
  deployment: string;
  indexer: IndexerStatus;
  relayer: RelayerStatus;
  keeper: KeeperStatus;
  // Added by the on-chain workers audit (M-3, I-2); absent in a status written by an older release.
  /** Unix ms when the on-chain workers started. */
  startedAt?: number;
  /** Why the on-chain workers are disabled although ONCHAIN_WORKERS=true (invalid settings, Redis not a socket). */
  error?: string | null;
  /** PRICE_PUSH_INTERVAL_MS. */
  pushIntervalMs?: number;
  roles?: { relayer: RoleHealth; keeper: RoleHealth; indexer: RoleHealth };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown) => v === null || isNum(v);
const strOrNull = (v: unknown, max = 200) => v === null || (typeof v === 'string' && v.length <= max);

const MAX_ALERTS = 16;
const alertsOk = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= MAX_ALERTS && v.every((a) => typeof a === 'string' && a.length <= 300));

function roleOk(v: unknown): boolean {
  return isRecord(v) && typeof v.enabled === 'boolean' && (v.lockHeld === null || typeof v.lockHeld === 'boolean') && numOrNull(v.lastOkAt) && isNum(v.everyMs);
}

function senderOk(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return (
    alertsOk(v.alerts) &&
    typeof v.enabled === 'boolean' &&
    strOrNull(v.address, 42) &&
    typeof v.sending === 'boolean' &&
    strOrNull(v.balanceWei, 80) &&
    typeof v.balanceLow === 'boolean' &&
    typeof v.inflight === 'boolean' &&
    typeof v.stuck === 'boolean' &&
    typeof v.gasCapped === 'boolean' &&
    strOrNull(v.lastTx, 66) &&
    numOrNull(v.lastConfirmedAt) &&
    strOrNull(v.error, 500)
  );
}

/**
 * The on-chain status read back from Redis (after the MAC check), or null when it is malformed, oversized or
 * dated more than 30 s ahead of `now`.
 */
export function parseOnchainStatus(raw: unknown, now: number): OnchainStatus | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ONCHAIN_STATUS_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || v.v !== 1 || !isNum(v.at) || v.at > now + 30_000 || !isNum(v.chainId) || typeof v.deployment !== 'string') return null;
  const ix = v.indexer;
  if (!isRecord(ix) || typeof ix.enabled !== 'boolean' || !numOrNull(ix.block) || !numOrNull(ix.head) || !numOrNull(ix.lagBlocks) || !numOrNull(ix.lastRunAt) || !isNum(ix.reorgs) || !strOrNull(ix.error, 500)) return null;
  const r = v.relayer;
  if (!senderOk(r) || !isRecord(r) || !numOrNull(r.lastPushAt) || !numOrNull(r.lastPushBlockTime) || !(r.sequencerUp === null || typeof r.sequencerUp === 'boolean') || !isRecord(r.markets)) return null;
  if (Object.keys(r.markets).length > MAX_ENTRIES || !Object.values(r.markets).every((s) => typeof s === 'string' && s.length <= 40)) return null;
  const k = v.keeper;
  if (!senderOk(k) || !isRecord(k) || !numOrNull(k.lastRunAt) || !isNum(k.liquidations) || !isNum(k.forcedExits) || !isNum(k.fundingAdvances) || !isNum(k.coverPayouts)) return null;
  // Fields added by the on-chain workers audit: optional (an older release's status lacks them), checked when present.
  if (v.startedAt !== undefined && !isNum(v.startedAt)) return null;
  if (v.error !== undefined && !strOrNull(v.error, 500)) return null;
  if (v.pushIntervalMs !== undefined && !isNum(v.pushIntervalMs)) return null;
  if (v.roles !== undefined) {
    const roles = v.roles;
    if (!isRecord(roles) || !roleOk(roles.relayer) || !roleOk(roles.keeper) || !roleOk(roles.indexer)) return null;
  }
  return v as unknown as OnchainStatus;
}

// ---------------------------------------------------------------- signer status (velum-signer -> file -> API)
//
// On-chain audit M-2: the price relayer and the keeper hold the hot keys, so they run in their own process
// (velum-signer, apps/workers/src/signer.ts) as their own Unix user, which the app user (api + workers) can neither
// read nor signal. That process uses no Redis and no Postgres: it reports to /v1/health through a JSON file (no
// secrets) in a directory root creates at boot (tmpfiles.d), owned by the signer user and readable, not writable, by
// the app user's group. Its integrity rests on those permissions (the app user cannot write it), so it has no MAC.

/** The signer's status file (SIGNER_STATUS_FILE). */
export const SIGNER_STATUS_FILE_DEFAULT = '/run/velum-signer/status.json';
/** The hot keys (SIGNER_KEYS_FILE): root-owned, readable only by the signer user; deploy/new-key.sh writes it. */
export const SIGNER_KEYS_FILE_DEFAULT = '/etc/velum/signer-keys.env';
/** The hot keys the signer reads from SIGNER_KEYS_FILE (never from its environment, never from .env). */
export const SIGNER_HOT_KEYS = ['PRICE_RELAY_PRIVATE_KEY', 'KEEPER_PRIVATE_KEY'] as const;
/** Raw JSON larger than this is never parsed. */
export const MAX_SIGNER_STATUS_BYTES = 16 * 1024;
/** How often the signer rewrites its status. */
export const SIGNER_STATUS_EVERY_MS = 5000;

export interface SignerStatus {
  v: 1;
  /** Unix ms when the signer wrote this. */
  at: number;
  chainId: number;
  /** The deployment's perps address; empty while the signer signs nothing (`error`, or not requested). */
  deployment: string;
  /** Unix ms when the signer process started. */
  startedAt: number;
  /** ONCHAIN_WORKERS=true: the signer is meant to run the relayer and the keeper. */
  requested: boolean;
  /** Why the signer runs neither role although requested (no deployment file, invalid settings, keys unreadable). */
  error: string | null;
  /** PRICE_PUSH_INTERVAL_MS. */
  pushIntervalMs: number;
  relayer: RelayerStatus;
  keeper: KeeperStatus;
  /** `lockHeld`: this process holds the signer's single-instance lock (a unix socket in its own home). */
  roles: { relayer: RoleHealth; keeper: RoleHealth };
  /** The signer's own Robinhood quotes: when it last read them and each market's state ("live", "unconfirmed", ...). */
  prices: { lastPollAt: number | null; markets: Record<string, string> };
}

/**
 * The signer's status read from its file, or null when it is malformed, oversized or dated more than 30 s ahead of
 * `now` (the same field checks as parseOnchainStatus).
 */
export function parseSignerStatus(raw: unknown, now: number): SignerStatus | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SIGNER_STATUS_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || v.v !== 1 || !isNum(v.at) || v.at > now + 30_000 || !isNum(v.chainId) || typeof v.deployment !== 'string' || v.deployment.length > 42) return null;
  if (!isNum(v.startedAt) || typeof v.requested !== 'boolean' || !strOrNull(v.error, 500) || !isNum(v.pushIntervalMs)) return null;
  const r = v.relayer;
  if (!senderOk(r) || !isRecord(r) || !numOrNull(r.lastPushAt) || !numOrNull(r.lastPushBlockTime) || !(r.sequencerUp === null || typeof r.sequencerUp === 'boolean') || !isRecord(r.markets)) return null;
  if (Object.keys(r.markets).length > MAX_ENTRIES || !Object.values(r.markets).every((s) => typeof s === 'string' && s.length <= 40)) return null;
  const k = v.keeper;
  if (!senderOk(k) || !isRecord(k) || !numOrNull(k.lastRunAt) || !isNum(k.liquidations) || !isNum(k.forcedExits) || !isNum(k.fundingAdvances) || !isNum(k.coverPayouts)) return null;
  const roles = v.roles;
  if (!isRecord(roles) || !roleOk(roles.relayer) || !roleOk(roles.keeper)) return null;
  const p = v.prices;
  if (!isRecord(p) || !numOrNull(p.lastPollAt) || !isRecord(p.markets)) return null;
  if (Object.keys(p.markets).length > MAX_ENTRIES || !Object.values(p.markets).every((s) => typeof s === 'string' && s.length <= 40)) return null;
  return v as unknown as SignerStatus;
}
