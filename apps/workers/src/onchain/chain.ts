/** viem clients and parsed ABIs for the Phase 3 contracts. */
import { BOOK_ABI, ERC20_ABI, ORACLE_ABI, PERPS_ABI, SPOT_ABI, VAULT_ABI } from '@velum/config/src/onchain-abi';
import { createPublicClient, defineChain, http, parseAbi, type Chain, type PublicClient } from 'viem';

export const abis = {
  vault: parseAbi(VAULT_ABI),
  oracle: parseAbi(ORACLE_ABI),
  spotPools: parseAbi(SPOT_ABI),
  makerBook: parseAbi(BOOK_ABI),
  perpsMarkets: parseAbi(PERPS_ABI),
  erc20: parseAbi(ERC20_ABI),
} as const;

/** A minimal viem chain for `chainId` (signing embeds the chain id: EIP-155). */
export function chainFor(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/**
 * Public client with JSON-RPC batching (concurrent reads of one tick go out as one HTTP request), a 10 s
 * timeout and one retry. Never logs the URL (it may carry a provider key; the workers' logger redacts it too).
 */
export function publicClientFor(chainId: number, rpcUrl: string): PublicClient {
  return createPublicClient({
    chain: chainFor(chainId, rpcUrl),
    transport: http(rpcUrl, { batch: { batchSize: 50, wait: 0 }, timeout: 10_000, retryCount: 1 }),
  }) as PublicClient;
}
