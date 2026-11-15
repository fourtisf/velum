'use client';
/** Real public balances on the selected Robinhood Chain network (ETH + USDG + Stock Tokens). */
import { TOKENS } from '@velum/config';
import { fromUnits, type Wad } from '@velum/math';
import { useQuery } from '@tanstack/react-query';
import { erc20Abi } from 'viem';
import { publicClient } from './chain';

const TOKEN_LIST = Object.values(TOKENS);

export interface PublicBalances {
  /** Balances that were read, by symbol. */
  bal: Record<string, Wad>;
  /** Tokens whose balance could not be read this time: shown as unavailable, never as zero or dropped (audit web F12). */
  unavailable: string[];
}

export async function fetchPublicBalances(addr: `0x${string}`): Promise<PublicBalances> {
  const [eth, results] = await Promise.all([
    publicClient.getBalance({ address: addr }),
    publicClient.multicall({
      contracts: TOKEN_LIST.map((t) => ({ address: t.address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [addr] as const })),
      allowFailure: true,
    }),
  ]);
  const bal: Record<string, Wad> = { ETH: fromUnits(eth, 18) };
  const unavailable: string[] = [];
  results.forEach((r, i) => {
    const t = TOKEN_LIST[i]!;
    if (r.status === 'success' && typeof r.result === 'bigint') bal[t.symbol] = fromUnits(r.result, t.decimals);
    else unavailable.push(t.symbol);
  });
  return { bal, unavailable };
}

export function usePublicBalances(addr: `0x${string}` | undefined) {
  return useQuery({
    queryKey: ['public-balances', addr],
    queryFn: () => fetchPublicBalances(addr!),
    enabled: !!addr,
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: 2,
  });
}
