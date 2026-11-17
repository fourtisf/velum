/**
 * Risk tools for real perps on Hyperliquid's xyz dex, as pure, exact math (decimal strings and bigint) shared by the
 * ticket, the dialogs, the flows and the tests:
 *  - take profit / stop loss: reduce-only trigger market orders (Hyperliquid "tp" / "sl"), checked against the entry
 *    and the estimated liquidation price, with the P&L each would realise;
 *  - limit orders: the open plan priced at the user's limit (good until cancelled);
 *  - partial closes: a share of the position, rounded down to the lot size, at least the 10 USD order minimum;
 *  - isolated margin: add or remove, with the new liquidation price estimate;
 *  - the user's open orders (limit, take profit, stop loss) from frontendOpenOrders, for the Velum markets only.
 */
import { HL_MARKETS, HL_MIN_ORDER_USD, type HlMarket } from '@velum/config/src/hyperliquid';
import { parseWad, toDecimalString } from '@velum/math';
import { formatPrice } from '@nktkas/hyperliquid/utils';
import { limitPrice, planOpen, type OpenPlan, type OpenRefusal } from './order';

const WAD = 10n ** 18n;
/** Trigger market orders fill at most this far past the trigger (Hyperliquid's own TP/SL default is 10%). */
export const TPSL_SLIP_BPS = 1000n;

/** A price typed by the user, Hyperliquid-formatted (5 significant figures, 6 - szDecimals decimals), or null. */
export function userPrice(input: string, szDecimals: number): string | null {
  const w = parseWad(input.trim());
  if (w === null || w <= 0n) return null;
  try {
    const f = formatPrice(toDecimalString(w), szDecimals, 'perp');
    return parseWad(f) && parseWad(f)! > 0n ? f : null;
  } catch {
    return null;
  }
}

// ---------- Limit orders ----------
/** A limit order (good until cancelled) for about `notionalUsd` at `limitPx`: planOpen sized and priced at the limit. */
export function planLimit(p: { market: HlMarket; long: boolean; notionalUsd: string; leverage: number; limitPx: string; currentSzi?: string }): { ok: true; plan: OpenPlan } | { ok: false; reason: OpenRefusal } {
  const px = userPrice(p.limitPx, p.market.szDecimals);
  if (!px) return { ok: false, reason: 'price' };
  return planOpen({ market: p.market, long: p.long, notionalUsd: p.notionalUsd, leverage: p.leverage, markPx: px, slipBps: 0n, currentSzi: p.currentSzi });
}

// ---------- Take profit / stop loss ----------
export type TpslKind = 'tp' | 'sl';
export interface TpslOrder {
  kind: TpslKind;
  /** The trigger price (Hyperliquid-formatted). */
  triggerPx: string;
  /** The worst price the triggered market order may fill at (TPSL_SLIP_BPS past the trigger). */
  limitPx: string;
  /** P&L at the trigger for `size`, USD (signed, 2 decimals, rounded toward zero). */
  pnl: string;
}
export type TpslRefusal = 'tpPrice' | 'slPrice' | 'tpSide' | 'slSide' | 'slLiq' | 'none';

/**
 * The take profit and stop loss for a long or short of `size` coins entered at about `entryPx`: a long takes profit
 * above the entry and stops below it (and above its liquidation price, or the stop could never fire); a short the other
 * way. Either may be left empty, not both.
 */
export function planTpsl(p: { market: HlMarket; long: boolean; size: string; entryPx: string; tp: string; sl: string; liqPx?: bigint | null }): { ok: true; orders: TpslOrder[] } | { ok: false; reason: TpslRefusal } {
  const entry = parseWad(p.entryPx);
  const size = parseWad(p.size.replace(/^-/, ''));
  if (entry === null || entry <= 0n || size === null || size <= 0n) return { ok: false, reason: 'none' };
  const orders: TpslOrder[] = [];
  const dir = p.long ? 1n : -1n;
  const make = (kind: TpslKind, input: string): TpslRefusal | null => {
    if (!input.trim()) return null;
    const trig = userPrice(input, p.market.szDecimals);
    if (!trig) return kind === 'tp' ? 'tpPrice' : 'slPrice';
    const t = parseWad(trig)!;
    if (kind === 'tp' && (p.long ? t <= entry : t >= entry)) return 'tpSide';
    if (kind === 'sl' && (p.long ? t >= entry : t <= entry)) return 'slSide';
    if (kind === 'sl' && p.liqPx && (p.long ? t <= p.liqPx : t >= p.liqPx)) return 'slLiq';
    // The triggered order closes: it sells a long, buys back a short.
    const limitPx = limitPrice(trig, !p.long, TPSL_SLIP_BPS, p.market.szDecimals);
    if (!limitPx) return kind === 'tp' ? 'tpPrice' : 'slPrice';
    const pnlW = ((t - entry) * size * dir) / WAD;
    const cents = pnlW / 10n ** 16n;
    orders.push({ kind, triggerPx: trig, limitPx, pnl: toDecimalString(cents * 10n ** 16n, 2) });
    return null;
  };
  const a = make('tp', p.tp);
  if (a) return { ok: false, reason: a };
  const b = make('sl', p.sl);
  if (b) return { ok: false, reason: b };
  if (!orders.length) return { ok: false, reason: 'none' };
  return { ok: true, orders };
}

/** Hyperliquid order entries for TP/SL triggers closing `size` of a long or short (reduce-only trigger market orders). */
export function tpslEntries(o: { asset: number; long: boolean; size: string; orders: TpslOrder[] }) {
  return o.orders.map((t) => ({ a: o.asset, b: !o.long, p: t.limitPx, s: o.size, r: true, t: { trigger: { isMarket: true, triggerPx: t.triggerPx, tpsl: t.kind } } }));
}

// ---------- Partial close ----------
export interface PartialClose {
  asset: number;
  coin: string;
  isBuy: boolean;
  size: string;
  limitPx: string;
  /** Share closed, 1..100. */
  pct: number;
  /** About size x mark, USD (2 decimals, rounded down). */
  notional: string;
}

/** The reduce-only order closing `pct`% of a position of signed size `szi` (rounded down to the lot), or a reason it cannot. */
export function planPartialClose(p: { market: HlMarket; szi: string; markPx: string; slipBps: bigint; pct: number }): { ok: true; plan: PartialClose } | { ok: false; reason: 'size' | 'min' | 'price' } {
  const short = p.szi.startsWith('-');
  const abs = parseWad(short ? p.szi.slice(1) : p.szi);
  const mark = parseWad(p.markPx);
  if (abs === null || abs <= 0n || !Number.isInteger(p.pct) || p.pct < 1 || p.pct > 100) return { ok: false, reason: 'size' };
  if (mark === null || mark <= 0n) return { ok: false, reason: 'price' };
  const dec = p.market.szDecimals;
  const lot = 10n ** BigInt(18 - dec);
  const part = p.pct === 100 ? abs : ((abs * BigInt(p.pct)) / 100n / lot) * lot;
  if (part <= 0n) return { ok: false, reason: 'size' };
  const value = (part * mark) / WAD;
  // A whole close may be small; a partial one must meet the exchange's 10 USD order minimum.
  if (p.pct < 100 && value < BigInt(HL_MIN_ORDER_USD) * WAD) return { ok: false, reason: 'min' };
  const limitPx = limitPrice(p.markPx, short, p.slipBps, dec);
  if (!limitPx) return { ok: false, reason: 'price' };
  const size = toDecimalString(part, dec).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return { ok: true, plan: { asset: p.market.asset, coin: p.market.coin, isBuy: short, size, limitPx, pct: p.pct, notional: toDecimalString((value / 10n ** 16n) * 10n ** 16n, 2) } };
}

// ---------- Isolated margin ----------
/** Hyperliquid's ntli (USD x 1e6, integer) for adding (+) or removing (-) `usd` of margin, or null for a bad amount. */
export function ntliOf(usd: string, add: boolean): number | null {
  const w = parseWad(usd.trim());
  if (w === null || w <= 0n) return null;
  const micro = w / 10n ** 12n;
  if (micro <= 0n || micro > 10n ** 15n) return null;
  return Number(add ? micro : -micro);
}

/**
 * The liquidation price after changing an isolated position's margin by `deltaUsd` (wad, negative to remove), from
 * Hyperliquid's formula liq = price - side x marginAvailable / size / (1 - mm x side), with mm = 1 / (2 x maxLeverage):
 * the liquidation price moves by -side x delta / size / (1 - mm x side). Null when it cannot be estimated.
 */
export function liqAfterMargin(liqPx: string | null, deltaUsd: bigint, szi: string, maxLeverage: number): bigint | null {
  const liq = liqPx ? parseWad(liqPx) : null;
  const long = !szi.startsWith('-');
  const size = parseWad(long ? szi : szi.slice(1));
  if (liq === null || size === null || size <= 0n || !Number.isInteger(maxLeverage) || maxLeverage < 1) return null;
  const mm = WAD / (2n * BigInt(maxLeverage));
  const denom = long ? WAD - mm : WAD + mm;
  const move = (((deltaUsd * WAD) / size) * WAD) / denom;
  const out = long ? liq - move : liq + move;
  return out > 0n ? out : 0n;
}

// ---------- Open orders ----------
export type OpenOrderKind = 'limit' | 'tp' | 'sl' | 'other';
export interface OpenOrder {
  oid: number;
  coin: string;
  symbol: string;
  asset: number;
  kind: OpenOrderKind;
  /** "B" buys, "A" sells. */
  isBuy: boolean;
  sz: string;
  /** The limit price, or the trigger price of a TP/SL. */
  px: string;
  reduceOnly: boolean;
  /** A TP/SL on the whole position (size follows it). */
  position: boolean;
  time: number;
}

/** The Velum markets' open orders from a frontendOpenOrders answer, newest first (pure, for tests). */
export function readOpenOrders(list: unknown): OpenOrder[] {
  if (!Array.isArray(list)) return [];
  const out: OpenOrder[] = [];
  for (const o of list as Array<Record<string, unknown>>) {
    if (!o || typeof o.coin !== 'string' || typeof o.oid !== 'number') continue;
    const m = Object.values(HL_MARKETS).find((x) => x.coin === o.coin);
    if (!m) continue;
    const type = String(o.orderType ?? '');
    const trig = o.isTrigger === true;
    const kind: OpenOrderKind = /take profit/i.test(type) ? 'tp' : /stop/i.test(type) ? 'sl' : !trig && /limit/i.test(type) ? 'limit' : 'other';
    const px = trig ? String(o.triggerPx ?? '') : String(o.limitPx ?? '');
    out.push({ oid: o.oid, coin: o.coin, symbol: m.symbol, asset: m.asset, kind, isBuy: o.side === 'B', sz: String(o.sz ?? '0'), px, reduceOnly: o.reduceOnly === true, position: o.isPositionTpsl === true, time: typeof o.timestamp === 'number' ? o.timestamp : 0 });
  }
  return out.sort((a, b) => b.time - a.time);
}

/** The position's current TP and SL (position TP/SL first, else a reduce-only trigger on that coin), for display. */
export function tpslOf(orders: OpenOrder[], coin: string): { tp: OpenOrder | null; sl: OpenOrder | null } {
  const mine = orders.filter((o) => o.coin === coin && o.reduceOnly && (o.kind === 'tp' || o.kind === 'sl'));
  const pick = (k: TpslKind) => mine.filter((o) => o.kind === k).sort((a, b) => Number(b.position) - Number(a.position))[0] ?? null;
  return { tp: pick('tp'), sl: pick('sl') };
}

/** Human labels of an open order's kind. */
export const KIND_LABEL: Record<OpenOrderKind, string> = { limit: 'Limit', tp: 'Take profit', sl: 'Stop loss', other: 'Order' };
