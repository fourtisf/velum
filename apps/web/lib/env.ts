import { CHAIN } from '@velum/config';

/** Public runtime config. NEXT_PUBLIC_* values are inlined at build time. */
export const ENV = {
  apiUrl: (process.env.NEXT_PUBLIC_API_URL || '/api').replace(/\/$/, ''),
  demoMode: (process.env.NEXT_PUBLIC_DEMO_MODE ?? 'true') !== 'false',
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID || CHAIN.id),
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL && process.env.NEXT_PUBLIC_RPC_URL.startsWith('http') ? process.env.NEXT_PUBLIC_RPC_URL : CHAIN.rpcUrl,
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL || CHAIN.explorer,
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '',
  siteUrl: process.env.PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || '',
} as const;

if (ENV.chainId !== CHAIN.id && typeof window !== 'undefined') {
  console.warn(`NEXT_PUBLIC_CHAIN_ID=${ENV.chainId} does not match the verified testnet chain ${CHAIN.id}.`);
}
