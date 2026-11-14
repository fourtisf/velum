import { CHAIN, IS_MAINNET } from '@velum/config';

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

/** Public runtime config. NEXT_PUBLIC_* values are inlined at build time. RPC endpoints live in lib/rpc.ts. */
export const ENV = {
  apiUrl: (process.env.NEXT_PUBLIC_API_URL || '/api').replace(/\/$/, ''),
  // Phase 2 has no real write path: every action is simulated, so the notices stay on regardless of
  // NEXT_PUBLIC_DEMO_MODE (internal audit web M3). Phase 3 wires real transactions and revisits this.
  demoMode: true,
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID || CHAIN.id),
  explorerUrl: safeUrl(process.env.NEXT_PUBLIC_EXPLORER_URL, 'NEXT_PUBLIC_EXPLORER_URL')?.href.replace(/\/$/, '') ?? CHAIN.explorer,
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '',
  // Public in the browser bundle; falls back to the page origin (audit web L10).
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL || (browser ? window.location.origin : ''),
} as const;

if (ENV.chainId !== CHAIN.id && browser) {
  console.warn(`NEXT_PUBLIC_CHAIN_ID=${ENV.chainId} does not match ${CHAIN.label} (${CHAIN.id}). Set NEXT_PUBLIC_VELUM_NETWORK and NEXT_PUBLIC_CHAIN_ID together.`);
}
