'use client';
/**
 * The data-driven switch between the simulated app (Phase 2, the default) and real transactions (Phase 3).
 *
 * A build without a compiled deployment (next.config.mjs reads contracts/deployments/<chainId>.json of the
 * tree being built: NEXT_PUBLIC_VELUM_DEPLOYMENT) is the simulated demo, exactly as before: it never calls
 * /v1/deployment (no request, no 404 in the console).
 *
 * A build WITH a compiled deployment for this app's chain is a real build and never renders the demo, not
 * even on its first paint (web audit W3-02): every view is the real one, reading the chain at the compiled
 * addresses. New trades and deposits need the API to confirm the same deployment (GET /v1/deployment: same
 * chain, contracts and tokens). Until it does (checking, the API unreachable or erroring, no deployment on
 * the API, or a different one) they are paused with the reason on screen, while exits keep working from
 * the compiled addresses and chain reads: withdrawals, closes, margin, forced exits, offer withdrawals,
 * liquidity removal and bond claims. Robinhood Chain mainnet (4663) is a real build only when the compiled
 * deployment is itself for 4663 (the guarded beta); the local development chain (31337) only on a testnet
 * build with a loopback RPC (lib/env.ts).
 */
import { IS_MAINNET } from '@velum/config';
import { ONCHAIN_MAINNET_CHAIN_ID, parseDeployment, type Deployment, type LowerAddress } from '@velum/config/src/onchain';
import { create } from 'zustand';
import { api, ApiError } from '../api';
import { ENV } from '../env';

export type { Deployment };

/**
 * `off`: no compiled deployment (the simulated demo). On a real build: `checking` (no answer yet), `on`
 * (the API serves this deployment), `unavailable` (network error, timeout or 5xx), `missing` (the API has
 * no deployment: 404) or `mismatch` (the API serves another one).
 */
export type OnchainStatus = 'off' | 'checking' | 'on' | 'unavailable' | 'missing' | 'mismatch';

export interface OnchainInfo {
  d: Deployment;
  /** Market symbols of the deployment (every token but USDG), sorted. */
  markets: string[];
  /** Close-only flags the API reported (null while its index cannot be read). */
  closeOnly: Record<string, boolean> | null;
  /** The API confirmed this deployment: new trades and deposits may be sent. Exits never wait for it. */
  verified: boolean;
  status: Exclude<OnchainStatus, 'off'>;
  /** What differs when the API serves another deployment (shown on screen), else null. */
  mismatch: string | null;
}

/** The deployment compiled into this build for `chainId`, or null (none, malformed, another chain). */
export function pinnedDeployment(raw: string | undefined, chainId: number): Deployment | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const p = parseDeployment(json, chainId);
  if (!p.ok) return null;
  // Mainnet is real only for a deployment that is itself for mainnet (parseDeployment checks the chain).
  if (chainId === ONCHAIN_MAINNET_CHAIN_ID && p.deployment.chainId !== ONCHAIN_MAINNET_CHAIN_ID) return null;
  return p.deployment;
}

const sameAddr = (a: LowerAddress | undefined, b: LowerAddress | undefined) => !!a && !!b && a === b;
const CORE = ['vault', 'oracle', 'spotPools', 'makerBook', 'perpsMarkets'] as const;
const CORE_NAME: Record<(typeof CORE)[number], string> = { vault: 'vault', oracle: 'oracle', spotPools: 'spot pools', makerBook: 'maker book', perpsMarkets: 'perps market' };

/**
 * What differs between the compiled deployment and the API's /v1/deployment answer, as a short phrase for the
 * screen ("a different vault address"), or null when they are the same deployment: same chain, the same five
 * core contracts and the same token list (symbols and addresses). Extra contract entries are allowed. Only
 * fixed phrases and the compiled deployment's own symbols are used, never text from the answer.
 */
export function deploymentDiff(pinned: Deployment, body: unknown): string | null {
  const chain = (body as { chainId?: unknown } | null)?.chainId;
  if (typeof chain === 'number' && Number.isSafeInteger(chain) && chain !== pinned.chainId) return `chain ID ${chain} instead of ${pinned.chainId}`;
  const p = parseDeployment(body, pinned.chainId);
  if (!p.ok) return 'an answer that is not a valid deployment';
  const d = p.deployment;
  for (const k of CORE) if (!sameAddr(pinned.contracts[k], d.contracts[k])) return `a different ${CORE_NAME[k]} address`;
  const a = Object.keys(pinned.tokens).sort();
  const b = Object.keys(d.tokens).sort();
  if (a.length !== b.length || a.some((s, i) => s !== b[i])) return 'a different token list';
  for (const s of a) if (!sameAddr(pinned.tokens[s], d.tokens[s])) return `a different ${s} token address`;
  return null;
}

/** Whether the API's /v1/deployment answer is the compiled deployment (deploymentDiff finds nothing). */
export function sameDeployment(pinned: Deployment, body: unknown): boolean {
  return deploymentDiff(pinned, body) === null;
}

/** Close-only flags from the API's `guard` block, validated (null when absent or malformed). */
export function apiCloseOnly(body: unknown): Record<string, boolean> | null {
  const g = (body as { guard?: { closeOnly?: unknown } } | null)?.guard?.closeOnly;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(g)) if (typeof v === 'boolean' && /^[A-Z][A-Z0-9]{0,11}$/.test(k)) out[k] = v;
  return out;
}

export const PINNED: Deployment | null = pinnedDeployment(process.env.NEXT_PUBLIC_VELUM_DEPLOYMENT, ENV.chainId);

/** A real build: a deployment is compiled in, so the simulated demo is never shown (W3-02). */
export const REAL_BUILD = PINNED !== null;

/**
 * Mainnet without Velum's own contracts: everything shown is the wallet's real state (balances, Uniswap trades,
 * Hyperliquid perps). The wallet connects without the private-account signature, and no simulated balance, private
 * address or demo ledger exists.
 */
export const WALLET_ONLY = IS_MAINNET && !REAL_BUILD;

/** The info a real build starts with (and keeps while the API cannot confirm it): exits only. */
export function unverified(d: Deployment, status: OnchainInfo['status'], mismatch: string | null = null): OnchainInfo {
  return { d, markets: Object.keys(d.tokens).filter((s) => s !== 'USDG').sort(), closeOnly: null, verified: false, status, mismatch };
}

interface OnchainState {
  status: OnchainStatus;
  info: OnchainInfo | null;
}

export const useOnchainState = create<OnchainState>(() => (PINNED ? { status: 'checking', info: unverified(PINNED, 'checking') } : { status: 'off', info: null }));

/** The deployment on a real build (verified or not), else null (the simulated demo). For non-React code. */
export const onchain = (): OnchainInfo | null => useOnchainState.getState().info;

/** The deployment on a real build (verified or not), else null (the simulated demo). */
export const useOnchain = (): OnchainInfo | null => useOnchainState((s) => s.info);

/** Back-off between checks while the API is unreachable, erroring, without a deployment or mismatched. */
const RETRY_MS = [2000, 5000, 15_000, 30_000];
const CHECK_TIMEOUT_MS = 8000;

/** The state after one /v1/deployment answer (or failure). Pure, so tests cover every case. */
export function checkResult(pinned: Deployment, r: { body: unknown } | { error: unknown }): OnchainState {
  if ('error' in r) {
    const notFound = r.error instanceof ApiError && r.error.status === 404;
    const status = notFound ? 'missing' : 'unavailable';
    return { status, info: unverified(pinned, status) };
  }
  const diff = deploymentDiff(pinned, r.body);
  if (diff !== null) return { status: 'mismatch', info: unverified(pinned, 'mismatch', diff) };
  return { status: 'on', info: { ...unverified(pinned, 'on'), closeOnly: apiCloseOnly(r.body), verified: true } };
}

/**
 * Asks the API once the app starts (only on a real build), and again with back-off until it confirms the
 * deployment. Once confirmed it stays confirmed for the page's life (a later API hiccup must not pause a
 * user's trades mid-session). A mismatch is reported on screen, not only in the console.
 */
export function startOnchainCheck(): () => void {
  if (!PINNED) return () => undefined;
  const pinned = PINNED;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  const run = async () => {
    if (stopped) return;
    let next: OnchainState;
    // A request that hangs counts as unavailable, so the screen never stays on "checking".
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
    try {
      next = checkResult(pinned, { body: await api.deployment(ctrl.signal) });
    } catch (error) {
      next = checkResult(pinned, { error });
    } finally {
      clearTimeout(t);
    }
    if (stopped) return;
    useOnchainState.setState(next);
    if (next.status !== 'on') timer = setTimeout(run, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
  };
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
