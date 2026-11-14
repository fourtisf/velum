'use client';
/** Real public balances on the selected Robinhood Chain network (ETH + USDG + stock tokens). */
import { TOKENS } from '@velum/config';
import { fromUnits, type Wad } from '@velum/math';
import { useQuery } from '@tanstack/react-query';
import { erc20Abi } from 'viem';
import { publicClient } from './chain';

const TOKEN_LIST = Object.values(TOKENS);

export async function fetchPublicBalances(addr: `0x${string}`): Promise<Record<string, Wad>> {
  const [eth, results] = await Promise.all([
    publicClient.getBalance({ address: addr }),
    publicClient.multicall({
      contracts: TOKEN_LIST.map((t) => ({ address: t.address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [addr] as const })),
      allowFailure: true,
    }),
  ]);
  const out: Record<string, Wad> = { ETH: fromUnits(eth, 18) };
  results.forEach((r, i) => {
    const t = TOKEN_LIST[i]!;
    if (r.status === 'success') out[t.symbol] = fromUnits(r.result as bigint, t.decimals);
  });
  return out;
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
