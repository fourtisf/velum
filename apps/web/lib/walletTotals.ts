'use client';
/** The mainnet wallet in one place: Robinhood Chain balances, ETH on Ethereum, and the total of both (lib/walletValue.ts). */
import type { Address } from 'viem';
import { usePublicBalances } from './balances';
import { useEthereumEth } from './ethereumEth';
import { fullTotal, l1EthValue, walletValue } from './walletValue';

export function useWalletTotals(addr: Address | undefined) {
  const pub = usePublicBalances(addr);
  const l1 = useEthereumEth(addr);
  const rh = walletValue(pub.data?.bal, pub.data?.unavailable);
  const { total, l1Missing } = fullTotal(rh, { wei: l1.data, pending: l1.isPending, error: l1.isError });
  return { pub, rh, l1, l1Value: l1EthValue(l1.data), total, l1Missing };
}
