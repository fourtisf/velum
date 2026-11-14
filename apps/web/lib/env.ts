import { CHAIN, IS_MAINNET } from '@velum/config';

/** An override for the other network's official endpoints is ignored (a common copy/paste slip). */
const OTHER_NET = IS_MAINNET ? /testnet\.chain\.robinhood\.com/ : /mainnet\.chain\.robinhood\.com|robinhoodchain\.blockscout\.com/;
const pick = (v: string | undefined, fallback: string) => (v && v.startsWith('http') && !OTHER_NET.test(v) ? v : fallback);

/** Public runtime config. NEXT_PUBLIC_* values are inlined at build time. */
export const ENV = {
  apiUrl: (process.env.NEXT_PUBLIC_API_URL || '/api').replace(/\/$/, ''),
  demoMode: (process.env.NEXT_PUBLIC_DEMO_MODE ?? 'true') !== 'false',
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID || CHAIN.id),
  rpcUrl: pick(process.env.NEXT_PUBLIC_RPC_URL, CHAIN.rpcUrl),
  explorerUrl: pick(process.env.NEXT_PUBLIC_EXPLORER_URL, CHAIN.explorer),
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '',
  siteUrl: process.env.PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || '',
} as const;

if (ENV.chainId !== CHAIN.id && typeof window !== 'undefined') {
  console.warn(`NEXT_PUBLIC_CHAIN_ID=${ENV.chainId} does not match ${CHAIN.label} (${CHAIN.id}). Set NEXT_PUBLIC_VELUM_NETWORK and NEXT_PUBLIC_CHAIN_ID together.`);
}
