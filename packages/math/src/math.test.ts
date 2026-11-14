import { describe, expect, it } from 'vitest';
import {
  WAD,
  bps,
  checkPerps,
  divRound,
  fromNumber,
  fromUnits,
  isLiquidatable,
  liquidationReturn,
  maxPerpsSize,
  parseWad,
  pctToWad,
  perpsClose,
  perpsOpen,
  pnl,
  roundSig,
  roundTo,
  spotQuote,
  swapHops,
  swapQuote,
  toDecimalString,
  toNumber,
  toUnits,
} from './index';

const P = { maxLeverage: 5, maintenanceMarginFactor: 0.5, takerFeeBps: 6, liquidationPenaltyBps: 100, spotPoolFeeBps: 30, maxTokensPerPosition: 100 };
const D = { makerOpenSpreadBps: 5, priceImpactBps: 8 };
const w = (s: string) => parseWad(s)!;
const close = (a: bigint | null, b: number, tol = 1e-9) => {
  expect(a).not.toBeNull();
  expect(Math.abs(toNumber(a!) - b)).toBeLessThanOrEqual(Math.abs(b) * tol + 1e-12);
};

describe('fixed point', () => {
  it('parses leniently like parseFloat', () => {
    expect(parseWad('500')).toBe(500n * WAD);
    expect(parseWad('0.5')).toBe(WAD / 2n);
    expect(parseWad('.25')).toBe(WAD / 4n);
    expect(parseWad('12abc')).toBe(12n * WAD);
    expect(parseWad('1e3')).toBe(1000n * WAD);
    expect(parseWad('-2.5')).toBe(-(5n * WAD) / 2n);
    expect(parseWad('abc')).toBeNull();
    expect(parseWad('')).toBeNull();
    expect(parseWad('0.1234567890123456789')).toBe(123456789012345678n);
  });
  it('rounds division in the requested direction', () => {
    expect(divRound(7n, 2n, 'floor')).toBe(3n);
    expect(divRound(7n, 2n, 'ceil')).toBe(4n);
    expect(divRound(-7n, 2n, 'floor')).toBe(-4n);
    expect(divRound(-7n, 2n, 'ceil')).toBe(-3n);
  });
  it('formats exactly', () => {
    expect(toDecimalString(w('391.65'))).toBe('391.65');
    expect(toDecimalString(w('391.655'), 2)).toBe('391.66');
    expect(toDecimalString(w('-0.004'), 2)).toBe('0.00');
    expect(toDecimalString(w('1234.5'), 0)).toBe('1235');
    expect(toDecimalString(roundTo(w('2.71828'), 4, 'floor'))).toBe('2.7182');
  });
  it('converts token units', () => {
    expect(fromUnits(1_000_000n, 6)).toBe(WAD);
    expect(toUnits(w('1.2345678'), 6)).toBe(1_234_567n);
    expect(fromUnits(5n * WAD, 18)).toBe(5n * WAD);
  });
  it('rounds to significant figures', () => {
    expect(toDecimalString(roundSig(w('1234567'), 2))).toBe('1200000');
    expect(toDecimalString(roundSig(w('2.54487'), 4))).toBe('2.544');
    expect(toDecimalString(roundSig(w('0.00255312'), 4))).toBe('0.002553');
  });
});

/* Reference implementations: the prototype's float formulas. */
const refPerps = (price: number, size: number, lev: number, side: 'long' | 'short') => {
  const entry = side === 'long' ? price * 1.0005 : price * 0.9995;
  const mm = 0.5 / 5;
  const liq = side === 'long' ? (lev <= 1 ? null : (entry * (1 - 1 / lev)) / (1 - mm)) : (entry * (1 + 1 / lev)) / (1 + mm);
  return { entry, margin: size / lev, qty: size / entry, fee: size * 0.0006, liq };
};

describe('perps', () => {
  it.each([
    [391.65, 500, 2, 'long'],
    [391.65, 500, 2, 'short'],
    [165.85, 1234.56, 4.5, 'long'],
    [612.4, 10000, 5, 'short'],
    [112.3, 50, 1, 'long'],
    [112.3, 50, 1, 'short'],
  ] as const)('matches the spec at P=%s S=%s L=%s %s', (price, size, lev, side) => {
    const q = perpsOpen({ price: fromNumber(price), size: fromNumber(size), leverage: lev, side }, P, D);
    const r = refPerps(price, size, lev, side);
    close(q.entry, r.entry);
    close(q.margin, r.margin);
    close(q.qty, r.qty);
    close(q.fee, r.fee);
    if (r.liq === null) expect(q.liq).toBeNull();
    else close(q.liq, r.liq);
  });

  it('rounds against the user', () => {
    const q = perpsOpen({ price: w('100'), size: w('100'), leverage: 3, side: 'long' }, P, D);
    expect(q.margin * 3n >= q.size).toBe(true);
    expect(wmulFloor(q.qty, q.entry) <= q.size).toBe(true);
  });

  it('checks button states in spec order', () => {
    const mk = (size: string) => perpsOpen({ price: w('391.65'), size: w(size), leverage: 2, side: 'long' }, P, D);
    expect(checkPerps(mk('0'), w('12500'), P)).toBe('no_size');
    expect(checkPerps(mk('500'), w('12500'), P)).toBe('ok');
    expect(checkPerps(mk('30000'), w('12500'), P)).toBe('insufficient');
    expect(checkPerps(mk('40000'), w('100000'), P)).toBe('over_limit');
  });

  it('computes P&L, liquidation and close like the spec', () => {
    const pos = { side: 'long' as const, qty: w('2'), entry: w('100'), margin: w('100') };
    expect(toDecimalString(pnl('long', pos.qty, pos.entry, w('110')))).toBe('20');
    expect(toDecimalString(pnl('short', pos.qty, pos.entry, w('110')))).toBe('-20');
    // margin + pnl < 0.1 * qty * P: at P=55 equity=10, required=11 -> liquidatable
    expect(isLiquidatable(pos, w('56'), P)).toBe(false);
    expect(isLiquidatable(pos, w('55'), P)).toBe(true);
    expect(toDecimalString(liquidationReturn(pos, w('55'), P))).toBe('8.9');
    const c = perpsClose(pos, w('110'), bps(5), P);
    const exit = 110 * (1 - 0.0005);
    const pl = 2 * (exit - 100);
    const fee = 2 * exit * 0.0006;
    close(c.exit, exit);
    close(c.pnl, pl);
    close(c.fee, fee);
    close(c.returned, 100 + pl - fee);
  });

  it('max size preset fits exactly within free balance', () => {
    const free = w('12500');
    for (const lev of [1, 2, 2.5, 5]) {
      const max = maxPerpsSize(free, lev, P);
      close(max, (12500 * lev) / (1 + 0.0006 * lev));
      const q = perpsOpen({ price: w('391.65'), size: max, leverage: lev, side: 'long' }, P, D);
      expect(q.margin + q.fee <= free).toBe(true);
    }
  });
});

describe('spot and swap', () => {
  it('matches spot buy/sell formulas', () => {
    const slip = pctToWad(0.5);
    const b = spotQuote('buy', w('500'), w('391.65'), slip, P, D);
    const bOut = (500 * (1 - 0.003)) / (391.65 * (1 + 0.0008));
    close(b.out, bOut);
    close(b.min, bOut * 0.995);
    close(b.fee, 1.5);
    const s = spotQuote('sell', w('2'), w('391.65'), slip, P, D);
    close(s.out, 2 * 391.65 * (1 - 0.0008) * (1 - 0.003));
    close(s.fee, 2 * 391.65 * 0.003);
  });

  it('matches swap formula for one and two hops', () => {
    expect(swapHops('USDG', 'TSLA')).toBe(1);
    expect(swapHops('NVDA', 'AMZN')).toBe(2);
    const slip = pctToWad(0.5);
    const one = swapQuote(w('1000'), WAD, w('391.65'), 1, slip, P, D);
    close(one.out, ((1000 * 1) / 391.65) * 0.997 * (1 - 0.0008));
    close(one.fee, 3);
    const two = swapQuote(w('10'), w('186.4'), w('233.4'), 2, slip, P, D);
    close(two.out, ((10 * 186.4) / 233.4) * 0.997 ** 2 * (1 - 0.0016));
    close(two.fee, 10 * 186.4 * (1 - 0.997 ** 2));
    close(two.rate, 186.4 / 233.4);
  });
});

function wmulFloor(a: bigint, b: bigint) {
  return (a * b) / WAD;
}
