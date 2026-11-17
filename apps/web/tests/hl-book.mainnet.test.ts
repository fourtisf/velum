/** The perps order book's shaping (lib/hyperliquid/book.ts): best levels first, running totals, mid, spread, depth scale. */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

import { shapeBook } from '@/lib/hyperliquid/book';

// A slice of the live xyz:TSLA book read on 2026-11-17 (best first on each side).
const levels: [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>] = [
  [
    { px: '377.64', sz: '2.648', n: 1 },
    { px: '377.63', sz: '11.23', n: 3 },
    { px: '377.62', sz: '7.63', n: 2 },
  ],
  [
    { px: '377.67', sz: '14.616', n: 1 },
    { px: '377.69', sz: '1.259', n: 1 },
    { px: '377.7', sz: '1.348', n: 1 },
  ],
];

describe('order book', () => {
  it('keeps the best levels first, with running size and USD totals', () => {
    const b = shapeBook(levels, 2);
    expect(b.bids.map((l) => l.px)).toEqual([377.64, 377.63]);
    expect(b.asks.map((l) => l.px)).toEqual([377.67, 377.69]);
    expect(b.bids[1]!.cum).toBeCloseTo(13.878, 6);
    expect(b.bids[1]!.cumUsd).toBeCloseTo(377.64 * 2.648 + 377.63 * 11.23, 6);
    expect(b.maxCum).toBeCloseTo(15.875, 6);
  });

  it('mid and spread from the best bid and ask', () => {
    const b = shapeBook(levels, 12);
    expect(b.mid).toBeCloseTo(377.655, 6);
    expect(b.spread).toBeCloseTo(0.03, 6);
    expect(b.spreadPct).toBeCloseTo((0.03 / 377.655) * 100, 6);
  });

  it('an empty or one-sided book has no mid or spread; bad levels are skipped', () => {
    expect(shapeBook(undefined, 5)).toMatchObject({ bids: [], asks: [], mid: null, spread: null, spreadPct: null, maxCum: 0 });
    const one = shapeBook([levels[0], []], 5);
    expect(one.mid).toBeNull();
    const bad = shapeBook([[{ px: 'x', sz: '1', n: 1 }, { px: '10', sz: '0', n: 1 }, { px: '9', sz: '2', n: 1 }], []], 5);
    expect(bad.bids).toEqual([{ px: 9, sz: 2, cum: 2, cumUsd: 18 }]);
  });
});
