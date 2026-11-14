/**
 * Demo market data (PRICE_SOURCE=demo). Original implementation of the prototype's random
 * walk, with gentle mean reversion so a server running for weeks stays near seed prices.
 * Floats are fine here: results are converted to clean decimal strings before storage.
 */
import { TIMEFRAME_MS, type Timeframe } from '@velum/config';
import { fromNumber, roundTo, toDecimalString } from '@velum/math';
import { bucketStart } from './candles';

export type Rng = () => number;

/** Standard normal sample (Box–Muller). */
export function gauss(rng: Rng = Math.random): number {
  let u = 0;
  let v = 0;
  while (!u) u = rng();
  while (!v) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const uniform = (a: number, b: number, rng: Rng = Math.random): number => a + rng() * (b - a);

/** Long-run spread of demo prices around the seed (8% standard deviation). */
const TARGET_STD = 0.08;
export const MIN_PRICE = 1;

/** One tick: p * (1 + gauss * vol - theta * ln(p / anchor)), never below MIN_PRICE. */
export function stepPrice(p: number, vol: number, anchor: number, rng: Rng = Math.random): number {
  const theta = (vol * vol) / (2 * TARGET_STD * TARGET_STD);
  const pull = anchor > 0 && p > 0 ? theta * Math.log(p / anchor) : 0;
  return Math.max(MIN_PRICE, p * (1 + gauss(rng) * vol - pull));
}

/** Float to a clean decimal string with `dp` decimals (trailing zeros trimmed). */
export function floatToDec(x: number, dp = 2): string {
  return toDecimalString(roundTo(fromNumber(x), dp, 'half'));
}

/** 24h open seed like the prototype: price * (1 + U(-3.4%, +3%)). */
export const seedOpen24h = (price: number, rng: Rng = Math.random): number => price * (1 + uniform(-0.034, 0.03, rng));

export interface FloatCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Volatility multiplier per timeframe, from the prototype's chart generator. */
export const TF_VOL: Record<Timeframe, number> = { '15m': 1, '1h': 1.9, '4h': 3.6, '1D': 7 };

/**
 * Synthetic history ending at the bucket containing `now`, oldest first. Walks backward from
 * `price` so the newest close equals the current price and each older close equals the next
 * candle's open (continuous series).
 */
export function genCandles(price: number, vol: number, tf: Timeframe, count: number, now: number, rng: Rng = Math.random): FloatCandle[] {
  const v = vol * TF_VOL[tf] * 2.3;
  const step = TIMEFRAME_MS[tf];
  const last = bucketStart(now, tf);
  const out: FloatCandle[] = [];
  let p = price;
  let drift = 0;
  for (let i = 0; i < count; i++) {
    if (i % 28 === 0) drift = uniform(-0.45, 0.45, rng) * v;
    // Keep history within a sane band around today's price.
    const dev = Math.log(p / price);
    if (Math.abs(dev) > 0.35) drift = Math.sign(dev) * Math.abs(drift);
    const c = p;
    const o = Math.max(MIN_PRICE, c * (1 - gauss(rng) * v - drift));
    const h = Math.max(o, c) * (1 + Math.abs(gauss(rng)) * v * 0.55);
    const l = Math.max(MIN_PRICE * 0.5, Math.min(o, c) * (1 - Math.abs(gauss(rng)) * v * 0.55));
    out.unshift({ t: last - i * step, o, h, l, c });
    p = o;
  }
  return out;
}

/** Synthetic sparkline (oldest first) ending at `price`, `stepsPerPoint` ticks between points. */
export function genSpark(price: number, vol: number, points: number, stepsPerPoint: number, rng: Rng = Math.random): number[] {
  const v = vol * Math.sqrt(Math.max(1, stepsPerPoint));
  const out = [price];
  let p = price;
  for (let i = 1; i < points; i++) {
    p = Math.max(MIN_PRICE, p * (1 - gauss(rng) * v));
    out.unshift(p);
  }
  return out;
}
