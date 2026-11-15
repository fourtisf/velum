/** Prototype calc functions (perpsCalc, spotCalc, swapCalc, privTotal) on top of @velum/math. */
import { DEMO, MARKETS, PROTOCOL } from '@velum/config';
import {
  WAD,
  bps,
  checkPerps,
  fromNumber,
  maxPerpsSize,
  pctToWad,
  perpsOpen,
  pnl,
  spotQuote,
  swapHops,
  swapQuote,
  wmul,
  type DemoParams,
  type PerpsCheck,
  type ProtocolParams,
  type Wad,
} from '@velum/math';
import { amountOrZero } from './amount';
import { livePrice, mk, tokPx } from './markets';
import { bal, type Ledger, type Position } from './store';

export const PARAMS: ProtocolParams = {
  maxLeverage: PROTOCOL.maxLeverage,
  maintenanceMarginFactor: PROTOCOL.maintenanceMarginFactor,
  takerFeeBps: PROTOCOL.takerFeeBps,
  liquidationPenaltyBps: PROTOCOL.liquidationPenaltyBps,
  spotPoolFeeBps: PROTOCOL.spotPoolFeeBps,
  maxTokensPerPosition: PROTOCOL.maxTokensPerPosition,
};
export const DEMO_PARAMS: DemoParams = { makerOpenSpreadBps: DEMO.makerOpenSpreadBps, priceImpactBps: DEMO.priceImpactBps };

/**
 * The leverage slider's low end: 1× is a position without leverage (CLAUDE.md §5, "slider 1–5"). PROTOCOL
 * has no minimum (any lower value would be under-collateralised by definition), so it lives here, once.
 */
export const MIN_LEVERAGE = 1;

export interface TicketInputs {
  sel: string;
  side: 'long' | 'short';
  lev: number;
  size: string;
  spotSide: 'buy' | 'sell';
  spotAmt: string;
  slip: number;
}

/**
 * Quotes take the tradable price (livePrice) and say whether they had one: without it every
 * price-derived figure is 0 and `priced` is false, so the UI shows dashes and blocks the action
 * (audit round 2, M4). Pass `price` to quote at a price read elsewhere (the ticket's hook).
 */
export function perpsCalc(s: Pick<TicketInputs, 'sel' | 'side' | 'lev' | 'size'>, free: Wad, price: Wad | null = livePrice(s.sel)) {
  const m = mk(s.sel);
  const q = perpsOpen({ price: price ?? 0n, size: amountOrZero(s.size), leverage: s.lev, side: s.side }, PARAMS, DEMO_PARAMS);
  const check: PerpsCheck = checkPerps(q, free, PARAMS);
  return { ...q, check, funding: m.funding, priced: price !== null };
}

export function maxSize(free: Wad, lev: number): Wad {
  return maxPerpsSize(free, lev, PARAMS);
}

/** Headroom under the token cap for presets, so a small price move right after can't tip it over. */
const CAP_HEADROOM = bps(50);

/**
 * Size for a 25/50/75/Max preset: `pct` of what the free balance allows, but never more than
 * the 100-token position cap at the current entry price, less 0.5% headroom (audit web I6).
 */
export function presetSize(free: Wad, lev: number, entry: Wad, pct: number): Wad {
  const byBalance = (maxSize(free, lev) * BigInt(pct)) / 100n;
  if (entry <= 0n) return byBalance;
  const byCap = wmul(wmul(fromNumber(PARAMS.maxTokensPerPosition), entry, 'floor'), WAD - CAP_HEADROOM, 'floor');
  return byBalance < byCap ? byBalance : byCap;
}

export function spotCalc(s: Pick<TicketInputs, 'sel' | 'spotSide' | 'spotAmt' | 'slip'>, priv: Record<string, Wad>, price: Wad | null = livePrice(s.sel)) {
  const m = mk(s.sel);
  const amt = amountOrZero(s.spotAmt);
  const buy = s.spotSide === 'buy';
  const q = spotQuote(s.spotSide, amt, price ?? 0n, pctToWad(s.slip), PARAMS, DEMO_PARAMS);
  const tin = buy ? 'USDG' : m.sym;
  const tout = buy ? m.sym : 'USDG';
  return { amt, out: q.out, min: q.min, feeAmt: q.fee, tin, tout, have: bal(priv, tin), price, priced: price !== null };
}

export function swapCalc(from: string, to: string, amount: string, slip: number, priv: Record<string, Wad>) {
  const a = amountOrZero(amount);
  const hops = swapHops(from, to);
  const pFrom = tokPx(from);
  const pTo = tokPx(to);
  const q = swapQuote(a, pFrom ?? 0n, pTo ?? 0n, hops, pctToWad(slip), PARAMS, DEMO_PARAMS);
  return { a, out: q.out, hops, fee: q.fee, rate: q.rate, min: q.min, have: bal(priv, from), priced: pFrom !== null && pTo !== null };
}

/** Unrealised P&L at the tradable price, or null when the market has none. */
export function posPnl(p: Position): Wad | null {
  const px = livePrice(p.sym);
  return px === null ? null : pnl(p.side, p.qty, p.entry, px);
}

/** Σ (margin + pnl) over open positions, or null when any of them has no price. */
export function inPos(l: Ledger): Wad | null {
  let t = 0n;
  for (const p of l.positions) {
    const v = posPnl(p);
    if (v === null) return null;
    t += p.margin + v;
  }
  return t;
}

/**
 * free USDG + Σ tokens × price + Σ (margin + pnl) + Σ LP + Σ maker backing + earned, or null when a
 * holding has no price (shown as a dash rather than a total that silently leaves it out).
 */
export function privTotal(l: Ledger): Wad | null {
  let t = bal(l.priv, 'USDG');
  for (const m of MARKETS) {
    const amt = bal(l.priv, m.symbol);
    if (amt === 0n) continue;
    const v = valueOf(m.symbol, amt);
    if (v === null) return null;
    t += v;
  }
  const pos = inPos(l);
  if (pos === null) return null;
  t += pos;
  for (const v of Object.values(l.lp)) t += v;
  for (const o of l.offers) t += o.back + o.earned;
  return t;
}

/** Value in USDG, or null when the token has no price. */
export function valueOf(t: string, amount: Wad): Wad | null {
  const px = tokPx(t);
  return px === null ? null : wmul(amount, px);
}
