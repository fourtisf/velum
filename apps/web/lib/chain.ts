import { CHAIN } from '@velum/config';
import { createPublicClient, defineChain } from 'viem';
import { ENV } from './env';
import { OFFICIAL_RPC, readTransport } from './rpc';

/**
 * The chain definition wallets see (wallet_addEthereumChain, WalletConnect, Coinbase): always the
 * official public RPC, never a custom provider URL that may carry an API key (audit web L12).
 */
export const robinhoodChain = defineChain({
  id: ENV.chainId,
  name: ENV.localRpc ? 'Local test chain' : CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [OFFICIAL_RPC] } },
  blockExplorers: { default: { name: 'Blockscout', url: ENV.explorerUrl, apiUrl: CHAIN.explorerApi } },
  contracts: { multicall3: { address: CHAIN.multicall3 } },
  testnet: CHAIN.testnet,
});

/** Reads go through our RPC (custom if it passed the chain check), so balances show even if the wallet is on another network. */
export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: readTransport(),
});
