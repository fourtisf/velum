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
 * While deferring a push the rate limit would clamp, the relay never lets its last push on chain get older
 * than this (seconds). Past it, it pushes the true price anyway so the on-chain price converges (lagging).
 * Bounds the extra exit option a deferral can give a closing taker to 15 s x 1/6000 = 0.25% of price.
 */
export const RELAY_MAX_PUSH_GAP_S = 15;
/** A price snapshot the price-relay job confirmed with its source longer ago than this is never pushed. */
export const RELAY_SNAPSHOT_MAX_AGE_MS = 10_000;

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
  deployment: string;
  indexer: IndexerStatus;
  relayer: RelayerStatus;
  keeper: KeeperStatus;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown) => v === null || isNum(v);
const strOrNull = (v: unknown, max = 200) => v === null || (typeof v === 'string' && v.length <= max);

function senderOk(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return (
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
  return v as unknown as OnchainStatus;
}
