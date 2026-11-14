/**
 * Protocol formulas from docs/01-product-spec.md section 6, in fixed point.
 * Rounding always favours the protocol: amounts a user pays round up, amounts a user
 * receives round down, liquidation prices round toward the current price.
 */
import { WAD, bps, divRound, fromNumber, wdiv, wmax, wmul, type Wad } from './fixed';

export type Side = 'long' | 'short';
export type SpotSide = 'buy' | 'sell';

export interface ProtocolParams {
  maxLeverage: number;
  maintenanceMarginFactor: number;
  takerFeeBps: number;
  liquidationPenaltyBps: number;
  spotPoolFeeBps: number;
  maxTokensPerPosition: number;
}

export interface DemoParams {
  makerOpenSpreadBps: number;
  priceImpactBps: number;
}

/** mm = maintenanceMarginFactor / maxLeverage (0.5 / 5 = 10%). */
export function maintenanceMargin(p: ProtocolParams): Wad {
  return wdiv(fromNumber(p.maintenanceMarginFactor), fromNumber(p.maxLeverage));
}

export interface PerpsOpenInput {
  price: Wad;
  size: Wad;
  leverage: number;
  side: Side;
}

export interface PerpsOpenQuote {
  size: Wad;
  leverage: Wad;
  entry: Wad;
  margin: Wad;
  qty: Wad;
  fee: Wad;
  /** null when the position cannot be liquidated (long at 1x). */
  liq: Wad | null;
}

export function perpsOpen(i: PerpsOpenInput, p: ProtocolParams, d: DemoParams): PerpsOpenQuote {
  const L = fromNumber(i.leverage);
  const spread = bps(d.makerOpenSpreadBps);
  const long = i.side === 'long';
  const entry = long ? wmul(i.price, WAD + spread, 'ceil') : wmul(i.price, WAD - spread, 'floor');
  const margin = L > 0n ? wdiv(i.size, L, 'ceil') : 0n;
  const qty = entry > 0n ? wdiv(i.size, entry, 'floor') : 0n;
  const fee = wmul(i.size, bps(p.takerFeeBps), 'ceil');
  const mm = maintenanceMargin(p);
  let liq: Wad | null = null;
  if (L > 0n) {
    const invL = wdiv(WAD, L, 'floor');
    if (long) liq = L <= WAD ? null : wdiv(wmul(entry, WAD - invL, 'ceil'), WAD - mm, 'ceil');
    else liq = wdiv(wmul(entry, WAD + invL, 'floor'), WAD + mm, 'floor');
  }
  return { size: i.size, leverage: L, entry, margin, qty, fee, liq };
}

/** Unrealised P&L at `price`. Rounded down. */
export function pnl(side: Side, qty: Wad, entry: Wad, price: Wad): Wad {
  const diff = side === 'long' ? price - entry : entry - price;
  return wmul(qty, diff, 'floor');
}

export interface PositionLike {
  side: Side;
  qty: Wad;
  entry: Wad;
  margin: Wad;
}

/** Liquidatable when margin + pnl < mm * qty * P. */
export function isLiquidatable(pos: PositionLike, price: Wad, p: ProtocolParams): boolean {
  const equity = pos.margin + pnl(pos.side, pos.qty, pos.entry, price);
  const required = wmul(wmul(maintenanceMargin(p), pos.qty, 'ceil'), price, 'ceil');
  return equity < required;
}

/** What the owner gets back after liquidation: max(0, equity - penalty * qty * P). */
export function liquidationReturn(pos: PositionLike, price: Wad, p: ProtocolParams): Wad {
  const equity = pos.margin + pnl(pos.side, pos.qty, pos.entry, price);
  const penalty = wmul(wmul(pos.qty, price, 'ceil'), bps(p.liquidationPenaltyBps), 'ceil');
  return wmax(0n, equity - penalty);
}

export interface PerpsCloseQuote {
  exit: Wad;
  pnl: Wad;
  fee: Wad;
  returned: Wad;
}

/** Close at the oracle price minus the maker's committed close spread (a fraction, as wad). */
export function perpsClose(pos: PositionLike, price: Wad, closeSpread: Wad, p: ProtocolParams): PerpsCloseQuote {
  const long = pos.side === 'long';
  const exit = long ? wmul(price, WAD - closeSpread, 'floor') : wmul(price, WAD + closeSpread, 'ceil');
  const pl = pnl(pos.side, pos.qty, pos.entry, exit);
  const fee = wmul(wmul(pos.qty, exit, 'ceil'), bps(p.takerFeeBps), 'ceil');
  return { exit, pnl: pl, fee, returned: wmax(0n, pos.margin + pl - fee) };
}

/** Largest size that fits the free balance at leverage L: free * L / (1 + fee * L). */
export function maxPerpsSize(free: Wad, leverage: number, p: ProtocolParams): Wad {
  if (free <= 0n) return 0n;
  const L = fromNumber(leverage);
  const fee = bps(p.takerFeeBps);
  let size = wdiv(wmul(free, L, 'floor'), WAD + wmul(fee, L, 'ceil'), 'floor');
  // margin and fee both round up, so step down the last few wei until it fits.
  for (let i = 0; i < 64 && size > 0n && wdiv(size, L, 'ceil') + wmul(size, fee, 'ceil') > free; i++) size -= 1n + L / WAD;
  return size;
}

export type PerpsCheck = 'ok' | 'no_size' | 'insufficient' | 'over_limit';

export function checkPerps(q: PerpsOpenQuote, free: Wad, p: ProtocolParams): PerpsCheck {
  if (q.size <= 0n) return 'no_size';
  if (q.margin + q.fee > free) return 'insufficient';
  if (q.qty > fromNumber(p.maxTokensPerPosition)) return 'over_limit';
  return 'ok';
}

export interface SpotQuote {
  amountIn: Wad;
  out: Wad;
  min: Wad;
  /** Pool fee in USDG. */
  fee: Wad;
}

/** slippage as a fraction wad (0.5% -> 0.005). */
export function spotQuote(side: SpotSide, amountIn: Wad, price: Wad, slippage: Wad, p: ProtocolParams, d: DemoParams): SpotQuote {
  const fee = bps(p.spotPoolFeeBps);
  const imp = bps(d.priceImpactBps);
  let out: Wad;
  let feeUsd: Wad;
  if (side === 'buy') {
    out = price > 0n ? wdiv(wmul(amountIn, WAD - fee, 'floor'), wmul(price, WAD + imp, 'ceil'), 'floor') : 0n;
    feeUsd = wmul(amountIn, fee, 'ceil');
  } else {
    out = wmul(wmul(wmul(amountIn, price, 'floor'), WAD - imp, 'floor'), WAD - fee, 'floor');
    feeUsd = wmul(wmul(amountIn, price, 'ceil'), fee, 'ceil');
  }
  return { amountIn, out, min: wmul(out, WAD - slippage, 'floor'), fee: feeUsd };
}

export interface SwapQuote {
  amountIn: Wad;
  out: Wad;
  min: Wad;
  hops: 1 | 2;
  /** Total pool fees in USDG. */
  fee: Wad;
  /** pFrom / pTo, before fees. */
  rate: Wad;
}

export function swapHops(from: string, to: string, quote = 'USDG'): 1 | 2 {
  return from === quote || to === quote ? 1 : 2;
}

/** a * pFrom / pTo * (1 - fee)^hops * (1 - impact * hops). Prices in USDG (USDG itself = 1). */
export function swapQuote(amountIn: Wad, priceFrom: Wad, priceTo: Wad, hops: 1 | 2, slippage: Wad, p: ProtocolParams, d: DemoParams): SwapQuote {
  const fee = bps(p.spotPoolFeeBps);
  const imp = bps(d.priceImpactBps);
  const keep = hops === 2 ? wmul(WAD - fee, WAD - fee, 'floor') : WAD - fee;
  const valueIn = wmul(amountIn, priceFrom, 'floor');
  const gross = priceTo > 0n ? wdiv(valueIn, priceTo, 'floor') : 0n;
  const out = wmul(wmul(gross, keep, 'floor'), WAD - imp * BigInt(hops), 'floor');
  const feeUsd = wmul(wmul(amountIn, priceFrom, 'ceil'), WAD - keep, 'ceil');
  const rate = priceTo > 0n ? wdiv(priceFrom, priceTo, 'floor') : 0n;
  return { amountIn, out, min: wmul(out, WAD - slippage, 'floor'), hops, fee: feeUsd, rate };
}

/** Percent number (0.5) to a fraction wad (0.005). */
export function pctToWad(pct: number): Wad {
  return divRound(fromNumber(pct), 100n, 'floor');
}
