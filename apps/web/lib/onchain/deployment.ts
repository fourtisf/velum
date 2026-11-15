'use client';
/**
 * The data-driven switch between the simulated app (Phase 2, the default) and real transactions (Phase 3).
 *
 * Real transactions need two things to agree:
 *  1. the deployment compiled into this build (next.config.mjs reads contracts/deployments/<chainId>.json
 *     of the tree being built: NEXT_PUBLIC_VELUM_DEPLOYMENT), for this app's chain; and
 *  2. GET /v1/deployment answering the same chain, contracts and tokens.
 * Until both hold, everything stays simulated with its labels, exactly as before. A build without a
 * deployment file never calls the endpoint (no request, no 404 in the console). Robinhood Chain mainnet
 * (4663) only goes real when the compiled deployment is itself for 4663 (the guarded beta); the local
 * development chain (31337) only on a testnet build with a loopback RPC (lib/env.ts).
 */
import { ONCHAIN_MAINNET_CHAIN_ID, parseDeployment, type Deployment, type LowerAddress } from '@velum/config/src/onchain';
import { create } from 'zustand';
import { api, ApiError } from '../api';
import { ENV } from '../env';

export type { Deployment };

export type OnchainStatus = 'off' | 'checking' | 'on' | 'mismatch';

export interface OnchainInfo {
  d: Deployment;
  /** Market symbols of the deployment (every token but USDG), sorted. */
  markets: string[];
  /** Close-only flags the API reported (null while its index cannot be read). */
  closeOnly: Record<string, boolean> | null;
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

/**
 * Whether the API's /v1/deployment answer is the compiled deployment: same chain, the same five core
 * contracts and the same token list (symbols and addresses). Extra contract entries are allowed.
 */
export function sameDeployment(pinned: Deployment, body: unknown): boolean {
  const p = parseDeployment(body, pinned.chainId);
  if (!p.ok) return false;
  const d = p.deployment;
  for (const k of ['vault', 'oracle', 'spotPools', 'makerBook', 'perpsMarkets'] as const) if (!sameAddr(pinned.contracts[k], d.contracts[k])) return false;
  const a = Object.keys(pinned.tokens).sort();
  const b = Object.keys(d.tokens).sort();
  return a.length === b.length && a.every((s, i) => s === b[i] && sameAddr(pinned.tokens[s], d.tokens[s]));
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

interface OnchainState {
  status: OnchainStatus;
  info: OnchainInfo | null;
}

export const useOnchainState = create<OnchainState>(() => ({ status: PINNED ? 'checking' : 'off', info: null }));

/** The live deployment when real transactions are on, else null (simulated). For non-React code (flows). */
export const onchain = (): OnchainInfo | null => useOnchainState.getState().info;

/** The live deployment when real transactions are on, else null (simulated). */
export const useOnchain = (): OnchainInfo | null => useOnchainState((s) => s.info);

const RETRY_MS = [2000, 5000, 15_000, 30_000];

/**
 * Asks the API once the app starts (only when this build carries a deployment). Retries on network errors
 * and 5xx; a 404 (no deployment on the API) or a different deployment keeps everything simulated. Once on,
 * it stays on for the page's life (a later API hiccup must not hide a user's real positions).
 */
export function startOnchainCheck(): () => void {
  if (!PINNED) return () => undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  const run = async () => {
    if (stopped) return;
    try {
      const body = await api.deployment();
      if (stopped) return;
      if (sameDeployment(PINNED, body)) {
        const markets = Object.keys(PINNED.tokens).filter((s) => s !== 'USDG').sort();
        useOnchainState.setState({ status: 'on', info: { d: PINNED, markets, closeOnly: apiCloseOnly(body) } });
      } else {
        console.warn('[velum] /v1/deployment does not match the deployment this build was made for; trades stay simulated.');
        useOnchainState.setState({ status: 'mismatch', info: null });
      }
    } catch (e) {
      if (stopped) return;
      if (e instanceof ApiError && e.status === 404) {
        useOnchainState.setState({ status: 'off', info: null });
        return;
      }
      timer = setTimeout(run, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
    }
  };
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
