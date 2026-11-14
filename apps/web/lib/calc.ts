/** Prototype calc functions (perpsCalc, spotCalc, swapCalc, privTotal) on top of @velum/math. */
import { DEMO, MARKETS, PROTOCOL } from '@velum/config';
import {
  checkPerps,
  maxPerpsSize,
  parseOrZero,
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
import { mk, tokPx } from './markets';
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

export interface TicketInputs {
  sel: string;
  side: 'long' | 'short';
  lev: number;
  size: string;
  spotSide: 'buy' | 'sell';
  spotAmt: string;
  slip: number;
}

export function perpsCalc(s: Pick<TicketInputs, 'sel' | 'side' | 'lev' | 'size'>, free: Wad) {
  const m = mk(s.sel);
  const q = perpsOpen({ price: m.price, size: parseOrZero(s.size), leverage: s.lev, side: s.side }, PARAMS, DEMO_PARAMS);
  const check: PerpsCheck = checkPerps(q, free, PARAMS);
  return { ...q, check, funding: m.funding };
}

export function maxSize(free: Wad, lev: number): Wad {
  return maxPerpsSize(free, lev, PARAMS);
}

export function spotCalc(s: Pick<TicketInputs, 'sel' | 'spotSide' | 'spotAmt' | 'slip'>, priv: Record<string, Wad>) {
  const m = mk(s.sel);
  const amt = parseOrZero(s.spotAmt);
  const buy = s.spotSide === 'buy';
  const q = spotQuote(s.spotSide, amt, m.price, pctToWad(s.slip), PARAMS, DEMO_PARAMS);
  const tin = buy ? 'USDG' : m.sym;
  const tout = buy ? m.sym : 'USDG';
  return { amt, out: q.out, min: q.min, feeAmt: q.fee, tin, tout, have: bal(priv, tin) };
}

export function swapCalc(from: string, to: string, amount: string, slip: number, priv: Record<string, Wad>) {
  const a = parseOrZero(amount);
  const hops = swapHops(from, to);
  const q = swapQuote(a, tokPx(from), tokPx(to), hops, pctToWad(slip), PARAMS, DEMO_PARAMS);
  return { a, out: q.out, hops, fee: q.fee, rate: q.rate, min: q.min, have: bal(priv, from) };
}

export const posPnl = (p: Position): Wad => pnl(p.side, p.qty, p.entry, mk(p.sym).price);

export const inPos = (l: Ledger): Wad => l.positions.reduce((a, p) => a + p.margin + posPnl(p), 0n);

/** free USDG + Σ tokens × price + Σ (margin + pnl) + Σ LP + Σ maker backing + earned */
export function privTotal(l: Ledger): Wad {
  let t = bal(l.priv, 'USDG');
  for (const m of MARKETS) t += wmul(bal(l.priv, m.symbol), mk(m.symbol).price);
  t += inPos(l);
  for (const v of Object.values(l.lp)) t += v;
  for (const o of l.offers) t += o.back + o.earned;
  return t;
}

export const valueOf = (t: string, amount: Wad): Wad => wmul(amount, tokPx(t));
