import { CHAIN, IS_MAINNET } from '@velum/config';
import { parseTokenCa } from './token-ca';

const browser = typeof window !== 'undefined';
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;
/** An override pointing at the other network's official endpoints is ignored (a common copy/paste slip). */
const OTHER_NET = IS_MAINNET ? /testnet\.chain\.robinhood\.com/ : /mainnet\.chain\.robinhood\.com|robinhoodchain\.blockscout\.com/;

export const warn = (msg: string) => {
  if (browser) console.warn(`[velum] ${msg}`);
};

/**
 * A configured endpoint override, or null when unset or unsafe: it must be https (plain http only
 * for a loopback dev node) and not the other network's official host (audit web L12).
 * Warnings name the setting, never the URL (provider URLs often embed an API key).
 */
export function safeUrl(v: string | undefined, label: string): URL | null {
  const raw = v?.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    warn(`${label} is not a valid URL; using the official endpoint.`);
    return null;
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.test(u.hostname))) {
    warn(`${label} must use https; using the official endpoint.`);
    return null;
  }
  if (OTHER_NET.test(u.host)) {
    warn(`${label} points at the other Robinhood Chain network; using the official endpoint.`);
    return null;
  }
  return u;
}

/** Anvil's chain id: a local development chain (contracts deployed with `forge script` on anvil). */
export const LOCAL_CHAIN_ID = 31337;

/**
 * A local development chain, for development and the end-to-end test only (apps/web/e2e): a testnet build
 * with NEXT_PUBLIC_CHAIN_ID=31337 and NEXT_PUBLIC_RPC_URL on a loopback address (http allowed) talks to that
 * node instead of Robinhood Chain. Anything else (a mainnet build, a non-loopback URL) is ignored. Returns the
 * node's URL, or null.
 */
export function localChainRpc(e: { chainId?: string; rpcUrl?: string }, mainnet = IS_MAINNET): string | null {
  if (mainnet || Number(e.chainId) !== LOCAL_CHAIN_ID || !e.rpcUrl) return null;
  let u: URL;
  try {
    u = new URL(e.rpcUrl.trim());
  } catch {
    return null;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.test(u.hostname) ? u.href.replace(/\/$/, '') : null;
}

const LOCAL_RPC = localChainRpc({ chainId: process.env.NEXT_PUBLIC_CHAIN_ID, rpcUrl: process.env.NEXT_PUBLIC_RPC_URL });

/** Public runtime config. NEXT_PUBLIC_* values are inlined at build time. RPC endpoints live in lib/rpc.ts. */
export const ENV = {
  apiUrl: (process.env.NEXT_PUBLIC_API_URL || '/api').replace(/\/$/, ''),
  // Phase 2 has no real write path: every action is simulated, so the notices stay on regardless of
  // NEXT_PUBLIC_DEMO_MODE (internal audit web M3). Phase 3 wires real transactions and revisits this.
  demoMode: true,
  /** The chain the app runs on: the configured network's, or the local development chain (localChainRpc). */
  chainId: LOCAL_RPC ? LOCAL_CHAIN_ID : CHAIN.id,
  /** The local development chain's RPC (loopback), or null on Robinhood Chain. */
  localRpc: LOCAL_RPC,
  explorerUrl: safeUrl(process.env.NEXT_PUBLIC_EXPLORER_URL, 'NEXT_PUBLIC_EXPLORER_URL')?.href.replace(/\/$/, '') ?? CHAIN.explorer,
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '',
  // Public in the browser bundle; falls back to the page origin (audit web L10).
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL || (browser ? window.location.origin : ''),
  /** Velum's token contract address on Robinhood Chain, or null ("Coming soon") unless it is a correctly checksummed address (lib/token-ca). */
  tokenCa: parseTokenCa(process.env.NEXT_PUBLIC_TOKEN_CA),
} as const;

const configuredChainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || CHAIN.id);
if (configuredChainId !== ENV.chainId && browser) {
  console.warn(`NEXT_PUBLIC_CHAIN_ID=${configuredChainId} does not match ${CHAIN.label} (${CHAIN.id}). Set NEXT_PUBLIC_VELUM_NETWORK and NEXT_PUBLIC_CHAIN_ID together.`);
}
