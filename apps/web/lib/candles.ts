/**
 * Candles from the API for the chart (final audit W-11): every candle is checked and a malformed one
 * is dropped, never drawn. The chart says "Chart unavailable" when the API sent candles but none of
 * them is valid. Display only: money logic never reads candles.
 *
 * Session view (docs/03 `sessions=true`): the API leaves out closed time that only repeats the last price and
 * marks the display-only on-chain DEX candles of closed periods (`src: "dex"`). chartLayout applies the same rule
 * again (an older API sends the plain series) and finds the session boundaries the chart separates.
 */
import { TIMEFRAME_MS, dropClosedRepeats, tradingDayOf, type Timeframe } from '@velum/config';
import { toNumber } from '@velum/math';
import { apiPrice } from './markets';

export interface ChartCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** An on-chain DEX candle of a closed period (display only), drawn hollow. */
  src?: 'dex';
  /** A DEX candle covering a whole closed period (1D): when that period ended (ms). */
  end?: number;
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
    const { t, o, h, l, c, src, end } = k as Record<string, unknown>;
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t <= 0) continue;
    const w = [apiPrice(o), apiPrice(h), apiPrice(l), apiPrice(c)];
    if (w.some((v) => v === null)) continue;
    const [ow, hw, lw, cw] = w as [bigint, bigint, bigint, bigint];
    if (lw > ow || lw > cw || hw < ow || hw < cw) continue;
    const candle: ChartCandle = { t, o: toNumber(ow), h: toNumber(hw), l: toNumber(lw), c: toNumber(cw) };
    if (src === 'dex') {
      candle.src = 'dex';
      if (typeof end === 'number' && Number.isSafeInteger(end) && end > t) candle.end = end;
    }
    byT.set(t, candle);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** A quote candle flat at the previous candle's close: nothing traded it (a closed market repeating its last quote). */
const repeatsLast = (c: ChartCandle, prev: ChartCandle | undefined): boolean =>
  c.src !== 'dex' && c.o === c.h && c.o === c.l && c.o === c.c && (prev === undefined || prev.c === c.c);

export interface ChartLayout {
  /** The candles to draw, evenly spaced: closed time that only repeats the last price is not among them. */
  list: ChartCandle[];
  /** Indexes i where a new session starts (a separator is drawn between i - 1 and i). Intraday only. */
  breaks: number[];
  /** Whether any on-chain DEX candle is drawn (the chart shows its legend). */
  hasDex: boolean;
}

/**
 * Session layout of the chart (TradingView-style session breaks): closed periods are compressed (their repeated
 * quote is not drawn as activity) and, on 15m/1h/4h, a subtle separator marks every session boundary (20:00 New York
 * time). The daily chart has one candle per session already and no separators. Real timestamps stay on the candles.
 */
export function chartLayout(list: readonly ChartCandle[], tf: Timeframe): ChartLayout {
  const kept = dropClosedRepeats(list, TIMEFRAME_MS[tf], repeatsLast);
  const breaks: number[] = [];
  if (tf !== '1D') for (let i = 1; i < kept.length; i++) if (tradingDayOf(kept[i]!.t) !== tradingDayOf(kept[i - 1]!.t)) breaks.push(i);
  return { list: kept, breaks, hasDex: kept.some((c) => c.src === 'dex') };
}

/**
 * The OHLC readout's time of a candle: real timestamps. Intraday buckets in local time; a daily candle stands for a
 * trading day (its `t` is that date at 00:00 UTC), so its date is read in UTC; a DEX candle of a closed period shows
 * the period. DEX candles carry the "On-chain DEX" prefix.
 */
export function readoutTime(c: ChartCandle, tf: Timeframe, locale = 'en-US', timeZone?: string): string {
  const dt = (t: number) => new Date(t).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
  let s: string;
  if (c.src === 'dex' && c.end) s = `${dt(c.t)} – ${dt(c.end)}`;
  else if (tf === '1D') s = new Date(c.t).toLocaleString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  else s = dt(c.t);
  return c.src === 'dex' ? `On-chain DEX · ${s}` : s;
}
