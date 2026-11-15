/**
 * Environment of the Phase 3 on-chain workers (price relayer, keeper, indexer). Everything is off unless
 * ONCHAIN_WORKERS=true AND contracts/deployments/<CHAIN_ID>.json exists (onchain/index.ts checks the file).
 * The hot keys are never part of the returned settings: they sit behind functions (JSON.stringify and the
 * logger skip functions) and are turned into viem accounts once, at start.
 */
import { defaultDeploymentsDir } from '@velum/config/src/deployment-file';
import { RELAY_INTERVAL_MS, type Hex } from '@velum/config/src/onchain';
import { parseWad } from '@velum/math';

export interface OnchainKeys {
  /** PRICE_RELAY_PRIVATE_KEY (deploy/new-key.sh), or null. */
  relay(): Hex | null;
  /** KEEPER_PRIVATE_KEY (deploy/new-key.sh), never the relay key, or null. */
  keeper(): Hex | null;
}

export interface OnchainEnv {
  /** ONCHAIN_WORKERS=true. The workers still need the deployment file of CHAIN_ID. */
  requested: boolean;
  /** DEPLOYMENTS_DIR, default contracts/deployments of the release. */
  deploymentsDir: string;
  /** ONCHAIN_MAINNET_CONFIRMED=yes: the owner allows transactions on Robinhood Chain mainnet (4663). */
  mainnetConfirmed: boolean;
  /** PRICE_PUSH_INTERVAL_MS, 8000-10000 (default 9000). */
  relayIntervalMs: number;
  /** RELAYER_MAX_GWEI as wei: the relay never pays a higher max fee per gas. */
  relayMaxFeeWei: bigint;
  /** KEEPER_MAX_GWEI as wei (default RELAYER_MAX_GWEI). */
  keeperMaxFeeWei: bigint;
  /** RELAYER_MIN_BALANCE_ETH as wei: below it the relayer warns and /v1/health says balanceLow. */
  relayMinBalanceWei: bigint;
  /** KEEPER_MIN_BALANCE_ETH as wei (default RELAYER_MIN_BALANCE_ETH). */
  keeperMinBalanceWei: bigint;
  /** INDEXER_START_BLOCK, or null (empty or 0) for the deployment file's startBlock. */
  startBlock: number | null;
  /** CONFIRMATIONS (default 3): blocks behind the head the indexer stays. */
  confirmations: number;
  /** INDEXER_CHUNK_BLOCKS (default 2000): largest eth_getLogs range. */
  chunkBlocks: number;
  /** INDEXER_POLL_MS (default 2000). */
  indexerPollMs: number;
  /** KEEPER_INTERVAL_MS (default 3000). */
  keeperIntervalMs: number;
  /** FUNDING_EPOCH_SECONDS (default 3600): the keeper advances a market's funding when it is older. */
  fundingEpochSeconds: number;
  /** KEEPER_ETH_PRICE_USD (default 4000): rough ETH price for the keeper's gas-versus-reward check. */
  ethPriceUsd: bigint;
  keys: OnchainKeys;
}

const GWEI = 10n ** 9n;
/** secp256k1 group order: a private key must be in [1, n - 1]. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** A decimal string ("0.05") as an integer with `decimals` decimals, or null (negative, malformed, too precise). */
export function parseFixed(raw: string, decimals: number): bigint | null {
  const s = raw.trim();
  if (!/^\d{1,12}(\.\d{1,18})?$/.test(s)) return null;
  const frac = s.split('.')[1] ?? '';
  if (frac.length > decimals) return null;
  const w = parseWad(s);
  return w === null ? null : w / 10n ** BigInt(18 - decimals);
}

/** Validates a hot key without ever putting it in a message. */
export function validKey(raw: string | undefined): Hex | null | 'invalid' {
  const v = (raw ?? '').trim();
  if (!v) return null;
  if (!KEY_RE.test(v)) return 'invalid';
  const n = BigInt(v);
  return n > 0n && n < SECP256K1_N ? (v as Hex) : 'invalid';
}

/** Read and validate the on-chain settings. Throws one error listing every problem (never a key value). */
export function loadOnchainEnv(e: NodeJS.ProcessEnv = process.env): OnchainEnv {
  const problems: string[] = [];
  const int = (name: string, dflt: number, min: number, max: number): number => {
    const raw = e[name];
    if (raw === undefined || raw.trim() === '') return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${min} and ${max} (got "${raw}").`);
      return dflt;
    }
    return n;
  };
  // A decimal amount as an integer of its smallest unit: gwei with 9 decimals is wei, ETH with 18 is wei.
  const fixed = (name: string, dflt: string, decimals: number, positive: boolean): bigint => {
    const raw = (e[name] ?? '').trim() || dflt;
    const v = parseFixed(raw, decimals);
    if (v === null || (positive && v === 0n)) {
      problems.push(`${name} must be a ${positive ? 'positive ' : ''}decimal number with at most ${decimals} decimals (got "${e[name]}").`);
      return parseFixed(dflt, decimals) ?? 0n;
    }
    return v;
  };

  // Only the literal "true" turns the workers on, exactly as deploy/ecosystem.config.cjs decides whether the
  // hot keys reach this process: anything else would let the two disagree.
  const flag = (e.ONCHAIN_WORKERS ?? '').trim().toLowerCase();
  if (flag !== '' && flag !== 'true' && flag !== 'false') problems.push(`ONCHAIN_WORKERS must be true or false (got "${e.ONCHAIN_WORKERS}").`);
  const confirmed = (e.ONCHAIN_MAINNET_CONFIRMED ?? '').trim().toLowerCase();
  if (confirmed !== '' && confirmed !== 'yes' && confirmed !== 'no') problems.push(`ONCHAIN_MAINNET_CONFIRMED must be yes or no (got "${e.ONCHAIN_MAINNET_CONFIRMED}").`);

  const relay = validKey(e.PRICE_RELAY_PRIVATE_KEY);
  const keeper = validKey(e.KEEPER_PRIVATE_KEY);
  if (relay === 'invalid') problems.push('PRICE_RELAY_PRIVATE_KEY is not a private key (0x + 64 hex digits). Create one with deploy/new-key.sh.');
  if (keeper === 'invalid') problems.push('KEEPER_PRIVATE_KEY is not a private key (0x + 64 hex digits). Create one with deploy/new-key.sh.');
  if (relay && keeper && relay !== 'invalid' && relay.toLowerCase() === (keeper as string).toLowerCase()) {
    problems.push('KEEPER_PRIVATE_KEY must not be the price-relay key: create a separate one with deploy/new-key.sh KEEPER_PRIVATE_KEY.');
  }

  const relayMaxFeeWei = fixed('RELAYER_MAX_GWEI', '1', 9, true);
  const startRaw = int('INDEXER_START_BLOCK', 0, 0, Number.MAX_SAFE_INTEGER);
  const relayMinBalanceWei = fixed('RELAYER_MIN_BALANCE_ETH', '0.05', 18, false);
  const env: OnchainEnv = {
    requested: flag === 'true',
    deploymentsDir: (e.DEPLOYMENTS_DIR ?? '').trim() || defaultDeploymentsDir(),
    mainnetConfirmed: confirmed === 'yes',
    relayIntervalMs: int('PRICE_PUSH_INTERVAL_MS', RELAY_INTERVAL_MS.default, RELAY_INTERVAL_MS.min, RELAY_INTERVAL_MS.max),
    relayMaxFeeWei,
    keeperMaxFeeWei: (e.KEEPER_MAX_GWEI ?? '').trim() ? fixed('KEEPER_MAX_GWEI', '1', 9, true) : relayMaxFeeWei,
    relayMinBalanceWei,
    keeperMinBalanceWei: (e.KEEPER_MIN_BALANCE_ETH ?? '').trim() ? fixed('KEEPER_MIN_BALANCE_ETH', '0.05', 18, false) : relayMinBalanceWei,
    startBlock: startRaw > 0 ? startRaw : null,
    confirmations: int('CONFIRMATIONS', 3, 0, 1000),
    chunkBlocks: int('INDEXER_CHUNK_BLOCKS', 2000, 1, 100_000),
    indexerPollMs: int('INDEXER_POLL_MS', 2000, 500, 60_000),
    keeperIntervalMs: int('KEEPER_INTERVAL_MS', 3000, 1000, 60_000),
    fundingEpochSeconds: int('FUNDING_EPOCH_SECONDS', 3600, 60, 7 * 86_400),
    ethPriceUsd: BigInt(int('KEEPER_ETH_PRICE_USD', 4000, 1, 1_000_000)),
    keys: {
      relay: () => (relay && relay !== 'invalid' ? relay : null),
      keeper: () => (keeper && keeper !== 'invalid' ? keeper : null),
    },
  };
  if (problems.length) throw new Error(`Invalid on-chain workers environment:\n  - ${problems.join('\n  - ')}`);
  return env;
}

/** wei as a decimal gwei string, for messages. */
export const weiToGwei = (wei: bigint): string => {
  const whole = wei / GWEI;
  const frac = (wei % GWEI).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};
