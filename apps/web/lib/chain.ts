import { CHAIN } from '@velum/config';
import { createPublicClient, defineChain, http } from 'viem';
import { ENV } from './env';

export const robinhoodTestnet = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [ENV.rpcUrl] } },
  blockExplorers: { default: { name: 'Blockscout', url: ENV.explorerUrl, apiUrl: CHAIN.explorerApi } },
  contracts: { multicall3: { address: CHAIN.multicall3 } },
  testnet: true,
});

/** Reads go through our RPC, so balances show even if the wallet is on another network. */
export const publicClient = createPublicClient({
  chain: robinhoodTestnet,
  transport: http(ENV.rpcUrl, { batch: true, retryCount: 2 }),
});
