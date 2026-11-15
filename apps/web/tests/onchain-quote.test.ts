/**
 * Exact quotes for the Phase 3 contracts (lib/onchain/quote.ts): the arithmetic mirrors contracts/src, the
 * constants match the Solidity sources, and every limit or minimum is non-zero and rounded against the user.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BPS,
  OFFER_SPREAD,
  PERPS,
  POOL_FEE_BPS,
  closeFee,
  closeLimit,
  exitPrice,
  leverageHalf,
  liquidationPrice,
  minOut,
  openLimit,
  openQuote,
  poolFee,
  poolOut,
  removeQuote,
  sharesFor,
  slipBps,
  sqrt,
  stockForUsdg,
  takerPnl,
  valueOfQty,
  valueScaleFor,
} from '@/lib/onchain/quote';

const E18 = 10n ** 18n;
const E6 = 1_000_000n;
const VS = valueScaleFor(6); // 1e30
const src = (f: string) => readFileSync(path.join(__dirname, '../../../contracts/src', f), 'utf8');

describe('constants match the contracts', () => {
  it('PerpsBase, SpotPools, MakerBook', () => {
    const base = src('perps/PerpsBase.sol');
    expect(base).toMatch(/MAX_LEVERAGE = 5;/);
    expect(base).toMatch(/TAKER_FEE_BPS = 6;/);
    expect(base).toMatch(/LIQUIDATION_PENALTY_BPS = 100;/);
    expect(base).toMatch(/MAX_POSITION_QTY = 100e18;/);
    expect(base).toMatch(/IM_BPS = BPS \/ MAX_LEVERAGE;/);
    expect(base).toMatch(/MM_BPS = BPS \/ 2 \/ MAX_LEVERAGE;/);
    expect(PERPS.imBps).toBe(BPS / PERPS.maxLeverage);
    expect(PERPS.mmBps).toBe(BPS / 2n / PERPS.maxLeverage);
    expect(PERPS.takerFeeBps).toBe(6n);
    expect(PERPS.maxQty).toBe(100n * E18);
    expect(src('SpotPools.sol')).toMatch(/FEE_BPS = 30;/);
    expect(POOL_FEE_BPS).toBe(30n);
    const book = src('MakerBook.sol');
    expect(book).toMatch(new RegExp(`MAX_SPREAD_BPS = ${OFFER_SPREAD.max};`));
    expect(book).toMatch(new RegExp(`MIN_OPEN_SPREAD_BPS = ${OFFER_SPREAD.minOpen};`));
  });

  it('valueScale = 10^(36 - USDG decimals)', () => {
    expect(valueScaleFor(6)).toBe(10n ** 30n);
    expect(valueScaleFor(18)).toBe(E18);
  });
});

describe('slippage and leverage inputs', () => {
  it('only the offered slippage options, as bps (default 0.5%)', () => {
    expect(slipBps(0.1)).toBe(10n);
    expect(slipBps(0.5)).toBe(50n);
    expect(slipBps(1)).toBe(100n);
    expect(slipBps(7)).toBe(50n);
    expect(slipBps(Number.NaN)).toBe(50n);
  });

  it('leverage 1x..5x in 0.5 steps as leverageHalf 2..10', () => {
    expect(leverageHalf(1)).toBe(2);
    expect(leverageHalf(2.5)).toBe(5);
    expect(leverageHalf(5)).toBe(10);
    expect(leverageHalf(0.5)).toBeNull();
    expect(leverageHalf(5.5)).toBeNull();
    expect(leverageHalf(2.25)).toBeNull();
  });
});

describe('perps open', () => {
  // contracts/README.md: 1,000 USDG at 5x -> margin 200, fee 0.6, maker margin 200.
  const q = openQuote({ price: 400n * E18, size: 1000n * E6, levHalf: 10, long: true, openBps: 10, slipBps: 50n, valueScale: VS });

  it('margin, maker margin and fee as the contract computes them', () => {
    expect(q.takerMargin).toBe(200n * E6);
    expect(q.makerMargin).toBe(200n * E6);
    expect(q.fee).toBe(600_000n);
    expect(q.cost).toBe(200n * E6 + 600_000n);
  });

  it('entry is worse for the taker by the open spread (up for longs, down for shorts)', () => {
    expect(q.entry).toBe(4004n * 10n ** 17n);
    const s = openQuote({ price: 400n * E18, size: 1000n * E6, levHalf: 10, long: false, openBps: 10, slipBps: 50n, valueScale: VS });
    expect(s.entry).toBe(3996n * 10n ** 17n);
  });

  it('qty = size x valueScale / entry, rounded down', () => {
    expect(q.qty).toBe((1000n * E6 * VS) / q.entry);
    expect(q.qty * q.entry <= 1000n * E6 * VS).toBe(true);
  });

  it('price limit from the slippage, never looser than asked and never zero', () => {
    expect(q.priceLimit).toBe((q.entry * 10_050n + 9_999n) / 10_000n);
    expect(openLimit(1000n, false, 100n)).toBe(990n);
    expect(openLimit(1n, false, 100n)).toBe(1n);
    expect(openLimit(1001n, true, 10n)).toBe(1003n); // 1001 x 1.001 = 1002.001, rounded up
  });

  it('margin rounds up for odd leverage', () => {
    const r = openQuote({ price: 400n * E18, size: 1000n * E6 + 1n, levHalf: 3, long: true, openBps: 2, slipBps: 50n, valueScale: VS });
    expect(r.takerMargin).toBe(((1000n * E6 + 1n) * 2n + 2n) / 3n);
  });
});

describe('liquidation price', () => {
  it('a 5x long is liquidated about 11% below entry, a 5x short about 9% above', () => {
    const qty = 25n * E17();
    const entry = 400n * E18;
    const margin = 200n * E6;
    const longLiq = liquidationPrice({ long: true, qty, entry, margin, valueScale: VS })!;
    // margin + qty(P - E) = 0.1 qty P  ->  P = (qty E - margin V) / (0.9 qty)
    expect(longLiq).toBe(((qty * entry - margin * VS) * BPS) / (qty * 9000n));
    expect(Number(longLiq / E18)).toBe(355);
    const shortLiq = liquidationPrice({ long: false, qty, entry, margin, valueScale: VS })!;
    expect(Number(shortLiq / E18)).toBe(436);
  });

  it('at the liquidation price the claim is at the maintenance margin', () => {
    const qty = 25n * E17();
    const entry = 400n * E18;
    const margin = 200n * E6;
    const p = liquidationPrice({ long: true, qty, entry, margin, valueScale: VS })!;
    const claim = margin + takerPnl(true, qty, entry, p, VS);
    const mm = (valueOfQty(qty, p, VS) * PERPS.mmBps) / BPS;
    expect(claim - mm <= 1n && claim - mm >= -1n).toBe(true);
  });

  it('a fully margined long has none', () => {
    expect(liquidationPrice({ long: true, qty: E18, entry: 100n * E18, margin: 100n * E6, valueScale: VS })).toBeNull();
    expect(liquidationPrice({ long: true, qty: 0n, entry: 100n * E18, margin: 1n, valueScale: VS })).toBeNull();
  });
});

describe('perps close', () => {
  it('exit = price minus the close spread (longs), plus it (shorts)', () => {
    expect(exitPrice(400n * E18, true, 5)).toBe(3998n * 10n ** 17n);
    expect(exitPrice(400n * E18, false, 5)).toBe(4002n * 10n ** 17n);
  });

  it('close fee 0.06% of exit notional, rounded up', () => {
    expect(closeFee(25n * E17(), 400n * E18, VS)).toBe(600_000n);
    expect(closeFee(1n, 1n, VS)).toBe(1n);
  });

  it('close limit: at least exit x (1 - slip) for longs, at most exit x (1 + slip) for shorts, never zero', () => {
    expect(closeLimit(1000n, true, 50n)).toBe(995n);
    expect(closeLimit(1000n, false, 50n)).toBe(1005n);
    expect(closeLimit(1n, true, 100n)).toBe(1n);
  });

  it('taker P&L rounds down (against the taker)', () => {
    expect(takerPnl(true, E18, 100n * E18, 101n * E18, VS)).toBe(E6);
    expect(takerPnl(false, E18, 100n * E18, 101n * E18, VS)).toBe(-E6);
    expect(takerPnl(true, 1n, 0n, 1n, VS)).toBe(0n);
    expect(takerPnl(false, 1n, 0n, 1n, VS)).toBe(-1n);
  });
});

describe('spot', () => {
  it('constant product with the 0.30% fee, like SpotPools._quote', () => {
    const out = poolOut(1000n * E6, 100_000n * E6, 250n * E18);
    const inAfter = (1000n * E6 * 9970n) / 10_000n;
    expect(out).toBe((inAfter * 250n * E18) / (100_000n * E6 + inAfter));
    expect(poolOut(1n, 0n, 1n)).toBe(0n);
    expect(poolFee(1000n * E6)).toBe(3n * E6);
  });

  it('minimum = quote x (1 - slip), rounded down; zero means too small to protect', () => {
    expect(minOut(1000n, 50n)).toBe(995n);
    expect(minOut(1n, 10n)).toBe(0n);
  });

  it('shares: first deposit sqrt - 1000, then the smaller ratio', () => {
    expect(sharesFor({ stockReserve: 0n, usdgReserve: 0n, totalShares: 0n }, 100n * E18, 40_000n * E6)).toBe(sqrt(100n * E18 * 40_000n * E6) - 1000n);
    const pool = { stockReserve: 100n * E18, usdgReserve: 40_000n * E6, totalShares: 1_000_000n };
    expect(sharesFor(pool, 10n * E18, 4_000n * E6)).toBe(100_000n);
    expect(sharesFor(pool, 10n * E18, 2_000n * E6)).toBe(50_000n);
    expect(sharesFor(pool, 0n, 1n)).toBe(0n);
  });

  it('remove returns the pro-rata slice, rounded down', () => {
    expect(removeQuote({ stockReserve: 100n * E18, usdgReserve: 40_000n * E6, totalShares: 1_000_000n }, 250_000n)).toEqual({ stock: 25n * E18, usdg: 10_000n * E6 });
    expect(removeQuote({ stockReserve: 1n, usdgReserve: 1n, totalShares: 0n }, 1n)).toEqual({ stock: 0n, usdg: 0n });
  });

  it('sqrt is a floor square root', () => {
    for (const x of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 36n, 10n ** 36n - 1n]) {
      const r = sqrt(x);
      expect(r * r <= x && (r + 1n) * (r + 1n) > x).toBe(true);
    }
    expect(() => sqrt(-1n)).toThrow();
  });

  it('stock for a USDG amount at a price, and back', () => {
    expect(stockForUsdg(400n * E6, 400n * E18, VS)).toBe(E18);
    expect(valueOfQty(E18, 400n * E18, VS)).toBe(400n * E6);
    expect(stockForUsdg(1n, 0n, VS)).toBe(0n);
  });
});

function E17() {
  return 10n ** 17n;
}
