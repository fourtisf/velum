/**
 * Candles from the API for the chart (final audit W-11): every candle is checked and a malformed one
 * is dropped, never drawn. The chart says "Chart unavailable" when the API sent candles but none of
 * them is valid. Display only: money logic never reads candles.
 */
import { toNumber } from '@velum/math';
import { apiPrice } from './markets';

export interface ChartCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/**
 * The valid candles in `data`, oldest first, one per bucket time: `t` a positive integer (ms), open,
 * high, low and close prices as the API validates them (decimal strings in (0, 1e9)), and the low and
 * high bracketing open and close. Anything that is not an array gives none.
 */
export function chartCandles(data: unknown): ChartCandle[] {
  if (!Array.isArray(data)) return [];
  const byT = new Map<number, ChartCandle>();
  for (const k of data as unknown[]) {
    if (!k || typeof k !== 'object') continue;
    const { t, o, h, l, c } = k as Record<string, unknown>;
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t <= 0) continue;
    const w = [apiPrice(o), apiPrice(h), apiPrice(l), apiPrice(c)];
    if (w.some((v) => v === null)) continue;
    const [ow, hw, lw, cw] = w as [bigint, bigint, bigint, bigint];
    if (lw > ow || lw > cw || hw < ow || hw < cw) continue;
    byT.set(t, { t, o: toNumber(ow), h: toNumber(hw), l: toNumber(lw), c: toNumber(cw) });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}
