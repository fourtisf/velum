'use client';
/**
 * The live order book of a stock perp (lib/hyperliquid, mainnet): Hyperliquid's l2Book for the market's coin, read every
 * 1.5 s while shown (weight 2 per read, well inside the per-IP limit), shaped for display: the best `depth` levels each
 * side with running totals, the mid price and the spread. Display only: orders still go out as limited IOC orders built
 * from a fresh mid (lib/hyperliquid/order.ts).
 */
import { HL_MARKETS } from '@velum/config/src/hyperliquid';
import { useQuery } from '@tanstack/react-query';
import { info } from './client';

export interface BookLevel {
  px: number;
  sz: number;
  /** Size summed from the best price out to this level. */
  cum: number;
  /** USD value summed from the best price out to this level. */
  cumUsd: number;
}

export interface Book {
  bids: BookLevel[];
  asks: BookLevel[];
  mid: number | null;
  spread: number | null;
  /** Spread as a share of the mid, in percent. */
  spreadPct: number | null;
  /** The larger side's total size, to scale the depth bars. */
  maxCum: number;
}

type RawLevel = { px: string; sz: string; n?: number };

/** Shapes Hyperliquid's levels ([bids, asks], best first) into the display book (pure: unit-tested). */
export function shapeBook(levels: [RawLevel[], RawLevel[]] | undefined, depth: number): Book {
  const side = (raw: RawLevel[] = []): BookLevel[] => {
    let cum = 0;
    let cumUsd = 0;
    const out: BookLevel[] = [];
    for (const l of raw.slice(0, depth)) {
      const px = Number(l.px);
      const sz = Number(l.sz);
      if (!Number.isFinite(px) || !Number.isFinite(sz) || px <= 0 || sz <= 0) continue;
      cum += sz;
      cumUsd += px * sz;
      out.push({ px, sz, cum, cumUsd });
    }
    return out;
  };
  const bids = side(levels?.[0]);
  const asks = side(levels?.[1]);
  const bestBid = bids[0]?.px ?? null;
  const bestAsk = asks[0]?.px ?? null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const maxCum = Math.max(bids.at(-1)?.cum ?? 0, asks.at(-1)?.cum ?? 0);
  return { bids, asks, mid, spread, spreadPct: mid && spread !== null ? (spread / mid) * 100 : null, maxCum };
}

export function useHlBook(sym: string, depth = 12) {
  const coin = HL_MARKETS[sym]?.coin ?? null;
  return useQuery({
    queryKey: ['hl-book', coin],
    enabled: !!coin,
    refetchInterval: 1500,
    staleTime: 1000,
    retry: 1,
    queryFn: async () => {
      const r = (await info.l2Book({ coin: coin! })) as { levels?: [RawLevel[], RawLevel[]] } | null;
      return r?.levels;
    },
    select: (levels) => shapeBook(levels, depth),
  });
}
