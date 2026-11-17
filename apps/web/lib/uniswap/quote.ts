'use client';
/**
 * On-chain quotes for real spot trades through Uniswap: every curated pool of the market is quoted for the exact input
 * (v3 through QuoterV2, v4 through V4Quoter: the pools' own math, fees and liquidity included), and the best output
 * wins. Nothing here guesses a price: a pool that cannot quote (no liquidity in range, a read error) is skipped, and
 * with no quote there is no trade.
 */
import { UNISWAP, sqrtPriceToWad, type UniPool } from '@velum/config/src/uniswap';
import { useQuery } from '@tanstack/react-query';
import { publicClient } from '../chain';
import { QUOTER_V2_ABI, V4_QUOTER_ABI } from './abi';
import { ethBuyPath, hopFor, zeroForOne, type Hop } from './encode';

export interface UniQuote {
  hop: Hop;
  amountIn: bigint;
  amountOut: bigint;
  /** Quotes of the other pools (for tests and the route line). */
  others: number;
}

/** Quotes one pool (null when it cannot fill the amount). */
export async function quotePool(hop: Hop, amountIn: bigint): Promise<bigint | null> {
  const cfg = UNISWAP;
  if (!cfg || amountIn <= 0n) return null;
  const p = hop.pool;
  try {
    if (p.version === 3) {
      const r = await publicClient.simulateContract({
        address: cfg.contracts.quoterV2,
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: hop.tokenIn, tokenOut: hop.tokenOut, amountIn, fee: p.fee, sqrtPriceLimitX96: 0n }],
      });
      return r.result[0] > 0n ? r.result[0] : null;
    }
    if (amountIn >= 1n << 128n) return null;
    const r = await publicClient.simulateContract({
      address: cfg.contracts.v4Quoter,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: { currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks }, zeroForOne: zeroForOne(hop), exactAmount: amountIn, hookData: '0x' }],
    });
    return r.result[0] > 0n ? r.result[0] : null;
  } catch {
    return null;
  }
}

/** The best quote among `pools` for an exact input, or null when none can fill it. */
export async function bestQuote(pools: readonly UniPool[], side: 'buy' | 'sell', amountIn: bigint): Promise<UniQuote | null> {
  const hops = pools.map((p) => hopFor(p, side));
  const outs = await Promise.all(hops.map((h) => quotePool(h, amountIn)));
  let at = -1;
  for (let i = 0; i < outs.length; i++) {
    const o = outs[i];
    if (o !== null && o !== undefined && (at < 0 || o > outs[at]!)) at = i;
  }
  if (at < 0) return null;
  return { hop: hops[at]!, amountIn, amountOut: outs[at]!, others: outs.filter((o) => o !== null).length - 1 };
}

export interface EthQuote {
  /** The market's v3 pool the second hop goes through. */
  pool: UniPool;
  amountIn: bigint;
  amountOut: bigint;
}

/**
 * The best quote for buying `sym` with `amountIn` wei of ETH: ETH -> USDG through the ETH leg, then USDG -> stock through
 * each of the market's v3 pools, quoted over the whole path by QuoterV2 (fees and liquidity of both pools included).
 */
export async function quoteEthBuy(sym: string, amountIn: bigint): Promise<EthQuote | null> {
  const cfg = UNISWAP;
  if (!cfg || amountIn <= 0n) return null;
  const pools = poolsOf(sym).filter((p) => p.version === 3);
  const outs = await Promise.all(
    pools.map(async (pool) => {
      try {
        const r = await publicClient.simulateContract({ address: cfg.contracts.quoterV2, abi: QUOTER_V2_ABI, functionName: 'quoteExactInput', args: [ethBuyPath(cfg.contracts.weth, cfg.ethLeg.fee, pool), amountIn] });
        return r.result[0] > 0n ? r.result[0] : null;
      } catch {
        return null;
      }
    }),
  );
  let at = -1;
  outs.forEach((o, i) => {
    if (o !== null && (at < 0 || o > outs[at]!)) at = i;
  });
  return at < 0 ? null : { pool: pools[at]!, amountIn, amountOut: outs[at]! };
}

/** Live ETH-buy quote for the ticket: refreshed every 10 s while shown. */
export function useEthQuote(sym: string | null, amountIn: bigint) {
  return useQuery({
    queryKey: ['uni-eth-quote', sym, amountIn.toString()],
    enabled: !!sym && amountIn > 0n && poolsOf(sym).some((p) => p.version === 3),
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: false,
    queryFn: () => quoteEthBuy(sym!, amountIn),
  });
}

/** The curated pools of a market (empty off mainnet or for a market without pools). */
export const poolsOf = (sym: string): UniPool[] => UNISWAP?.pools[sym] ?? [];

/** Live quote for the ticket and the swap page: refreshed every 10 s while shown. */
export function useUniQuote(sym: string | null, side: 'buy' | 'sell', amountIn: bigint) {
  return useQuery({
    queryKey: ['uni-quote', sym, side, amountIn.toString()],
    enabled: !!sym && amountIn > 0n && poolsOf(sym).length > 0,
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: false,
    queryFn: () => bestQuote(poolsOf(sym!), side, amountIn),
  });
}

/**
 * The marginal (mid) price of a pool before the trade, USDG per token as a wad, for the price-impact line; null when
 * unreadable. Read through the pool (v3 slot0) or StateView (v4).
 */
export async function poolMid(pool: UniPool): Promise<bigint | null> {
  const cfg = UNISWAP;
  if (!cfg) return null;
  try {
    const sqrt =
      pool.version === 3
        ? (
            await publicClient.readContract({
              address: pool.address,
              abi: [{ type: 'function', name: 'slot0', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' }] }] as const,
              functionName: 'slot0',
            })
          )[0]
        : (
            await publicClient.readContract({
              address: cfg.contracts.stateView,
              abi: [{ type: 'function', name: 'getSlot0', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint24' }, { type: 'uint24' }] }] as const,
              functionName: 'getSlot0',
              args: [pool.id],
            })
          )[0];
    return sqrtPriceToWad(sqrt, pool.stockIsToken0, cfg.decimals[pool.symbol]!, cfg.usdg.decimals);
  } catch {
    return null;
  }
}
