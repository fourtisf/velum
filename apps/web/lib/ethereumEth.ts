'use client';
/**
 * The wallet's ETH on Ethereum mainnet (the "ERC20" network, same address), read-only, for the mainnet Portfolio and
 * account card (packages/config/src/ethereum.ts). The RPC must answer chain 1 before any balance from it is shown.
 */
import { IS_MAINNET } from '@velum/config';
import { ETH_L1_CHAIN_ID, ETH_L1_RPC } from '@velum/config/src/ethereum';
import { useQuery } from '@tanstack/react-query';
import { createPublicClient, http, type Address } from 'viem';
import { mainnet } from 'viem/chains';

/** Ethereum mainnet reads (balances, receipts of deposits sent from Ethereum), through ETH_L1_RPC. */
export const l1 = createPublicClient({ chain: mainnet, transport: http(ETH_L1_RPC, { timeout: 15_000, retryCount: 1 }) });
let chainOk: Promise<boolean> | null = null;

/** ETH on Ethereum mainnet, wei. Throws when the RPC cannot be reached or is not Ethereum mainnet. */
export async function readEthereumEth(addr: Address): Promise<bigint> {
  chainOk ??= l1.getChainId().then(
    (id) => id === ETH_L1_CHAIN_ID,
    () => {
      chainOk = null; // a network error: check again next time
      return false;
    },
  );
  if (!(await chainOk)) throw new Error('The Ethereum RPC did not answer as Ethereum mainnet.');
  return l1.getBalance({ address: addr });
}

export function useEthereumEth(addr: Address | undefined) {
  return useQuery({
    queryKey: ['public-eth-l1', addr],
    queryFn: () => readEthereumEth(addr!),
    enabled: !!addr && IS_MAINNET,
    refetchInterval: 30_000,
    staleTime: 20_000,
    retry: 1,
  });
}
