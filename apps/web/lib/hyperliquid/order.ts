/**
 * Order math for real perps on Hyperliquid's xyz dex (packages/config/src/hyperliquid.ts): pure and exact (decimal
 * strings and bigint), so the ticket, the flow and the tests agree on every number. Market orders are IOC limit orders
 * at the mark price moved by the slippage setting against the user, priced and sized by Hyperliquid's tick and lot
 * rules (formatPrice / formatSize of @nktkas/hyperliquid: at most 5 significant figures and 6 - szDecimals decimals
 * for prices, szDecimals decimals for sizes, both rounded down).
 */
import { HL_MAX_LEVERAGE, HL_MAX_TOKENS, HL_MIN_ORDER_USD, type HlMarket } from '@velum/config/src/hyperliquid';
import { parseWad, toDecimalString } from '@velum/math';
import { formatPrice } from '@nktkas/hyperliquid/utils';

const WAD = 10n ** 18n;

/** Base units of a decimal string with `dp` decimals (rounded down), or null when it is not a plain non-negative decimal. */
function units(v: string, dp: number): bigint | null {
  const w = parseWad(v);
  if (w === null || w < 0n) return null;
  return (w * 10n ** BigInt(dp)) / WAD;
}
const fromUnits = (u: bigint, dp: number): string => toDecimalString((u * WAD) / 10n ** BigInt(dp), dp);

/** The IOC limit price: the mark moved by `slipBps` against the user (up for a buy), Hyperliquid-formatted. */
export function limitPrice(markPx: string, isBuy: boolean, slipBps: bigint, szDecimals: number): string | null {
  const m = parseWad(markPx);
  if (m === null || m <= 0n) return null;
  const px = isBuy ? (m * (10_000n + slipBps)) / 10_000n : (m * (10_000n - slipBps)) / 10_000n;
  try {
    return formatPrice(toDecimalString(px), szDecimals, 'perp');
  } catch {
    return null;
  }
}

export type OpenRefusal = 'leverage' | 'price' | 'size' | 'min' | 'max';

export interface OpenPlan {
  asset: number;
  coin: string;
  isBuy: boolean;
  /** Order size in coins (szDecimals decimals). */
  size: string;
  /** IOC limit price. */
  limitPx: string;
  leverage: number;
  /** size x mark, USD, 2 decimals (rounded down). */
  notional: string;
  /** Isolated margin the position needs at this leverage, plus a 0.1% fee allowance, USD rounded up to cents. */
  margin: string;
}

/**
 * The order for opening (or adding to) a position of about `notionalUsd` at `leverage`: refuses a leverage outside
 * 1..HL_MAX_LEVERAGE and the market's own maximum (an integer: Hyperliquid's updateLeverage takes integers), a size that rounds to zero, an order under
 * Hyperliquid's 10 USD minimum, or a position above HL_MAX_TOKENS once added to `currentSzi` (the signed size held now).
 */
export function planOpen(p: { market: HlMarket; long: boolean; notionalUsd: string; leverage: number; markPx: string; slipBps: bigint; currentSzi?: string }): { ok: true; plan: OpenPlan } | { ok: false; reason: OpenRefusal } {
  const { market, long, leverage } = p;
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > Math.min(HL_MAX_LEVERAGE, market.maxLeverage)) return { ok: false, reason: 'leverage' };
  const mark = parseWad(p.markPx);
  const notional = parseWad(p.notionalUsd);
  if (mark === null || mark <= 0n) return { ok: false, reason: 'price' };
  if (notional === null || notional <= 0n) return { ok: false, reason: 'size' };
  const dec = market.szDecimals;
  const sizeU = (notional * 10n ** BigInt(dec)) / mark;
  if (sizeU <= 0n) return { ok: false, reason: 'size' };
  const sizeW = (sizeU * WAD) / 10n ** BigInt(dec);
  const value = (sizeW * mark) / WAD;
  if (value < BigInt(HL_MIN_ORDER_USD) * WAD) return { ok: false, reason: 'min' };
  const held = p.currentSzi ? (parseWad(p.currentSzi.replace(/^-/, '')) ?? 0n) * (p.currentSzi.startsWith('-') ? -1n : 1n) : 0n;
  const after = held + (long ? sizeW : -sizeW);
  if ((after < 0n ? -after : after) > BigInt(HL_MAX_TOKENS) * WAD) return { ok: false, reason: 'max' };
  const limitPx = limitPrice(p.markPx, long, p.slipBps, dec);
  if (!limitPx) return { ok: false, reason: 'price' };
  const marginW = value / BigInt(leverage) + value / 1000n;
  const cents = (marginW + 10n ** 16n - 1n) / 10n ** 16n;
  return {
    ok: true,
    plan: { asset: market.asset, coin: market.coin, isBuy: long, size: fromUnits(sizeU, dec), limitPx, leverage, notional: toDecimalString((value / 10n ** 16n) * 10n ** 16n, 2), margin: toDecimalString(cents * 10n ** 16n, 2) },
  };
}

/**
 * The estimated liquidation price of a new isolated position entered at `entryPx` (wad), or null at 1x long (never
 * liquidated by price). Hyperliquid's maintenance margin is half the initial margin at the market's maximum leverage
 * (mm = 1 / (2 x maxLeverage)): long entry x (1 - 1/L) / (1 - mm), short entry x (1 + 1/L) / (1 + mm), the same formula
 * as Velum's own perps (packages/math perpsOpen). An estimate: fees and funding move it, Hyperliquid shows the exact one.
 */
export function liqEstimate(entry: bigint, long: boolean, leverage: number, maxLeverage: number): bigint | null {
  if (entry <= 0n || !Number.isInteger(leverage) || leverage < 1 || !Number.isInteger(maxLeverage) || maxLeverage < 1) return null;
  const L = BigInt(leverage);
  const mm = WAD / (2n * BigInt(maxLeverage));
  if (long) return L === 1n ? null : (entry * (WAD - WAD / L)) / (WAD - mm);
  return (entry * (WAD + WAD / L)) / (WAD + mm);
}

export interface ClosePlan {
  asset: number;
  coin: string;
  isBuy: boolean;
  size: string;
  limitPx: string;
}

/** The reduce-only order closing a position of signed size `szi` (negative: short), or null when there is nothing to close. */
export function planClose(p: { market: HlMarket; szi: string; markPx: string; slipBps: bigint }): ClosePlan | null {
  const short = p.szi.startsWith('-');
  const abs = short ? p.szi.slice(1) : p.szi;
  const u = units(abs, p.market.szDecimals);
  if (u === null || u <= 0n) return null;
  const isBuy = short;
  const limitPx = limitPrice(p.markPx, isBuy, p.slipBps, p.market.szDecimals);
  if (!limitPx) return null;
  return { asset: p.market.asset, coin: p.market.coin, isBuy, size: fromUnits(u, p.market.szDecimals), limitPx };
}

/** A builder fee to attach to orders: Velum's builder address and fee in tenths of a basis point, or none. */
export interface Builder {
  b: `0x${string}`;
  f: number;
}

/** A TP/SL trigger entry (risk.ts tpslEntries) that rides along with an order. */
export interface TriggerEntry {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { trigger: { isMarket: boolean; triggerPx: string; tpsl: 'tp' | 'sl' } };
}

/**
 * The `order` action parameters of @nktkas/hyperliquid for one order: IOC (market) by default, or Gtc (a limit order
 * resting until filled or cancelled). `tpsl` attaches take profit / stop loss triggers that wait for this order to fill
 * (grouping "normalTpsl").
 */
export function orderParams(o: { asset: number; isBuy: boolean; size: string; limitPx: string; reduceOnly: boolean }, builder: Builder | null, opts: { tif?: 'Ioc' | 'Gtc'; tpsl?: TriggerEntry[] } = {}) {
  const entry = { a: o.asset, b: o.isBuy, p: o.limitPx, s: o.size, r: o.reduceOnly, t: { limit: { tif: opts.tif ?? ('Ioc' as const) } } };
  const tpsl = opts.tpsl ?? [];
  return {
    orders: [entry, ...tpsl] as Array<typeof entry | TriggerEntry>,
    grouping: tpsl.length ? ('normalTpsl' as const) : ('na' as const),
    ...(builder ? { builder } : {}),
  };
}

export type OrderOutcome = { kind: 'filled'; totalSz: string; avgPx: string; oid: number } | { kind: 'resting'; oid: number } | { kind: 'error'; message: string };

/** The outcome of the single order of an `order` response (the SDK's success shape), read strictly. */
export function orderOutcome(res: unknown): OrderOutcome {
  const status = (res as { response?: { data?: { statuses?: unknown[] } } } | null)?.response?.data?.statuses?.[0] as Record<string, unknown> | string | undefined;
  if (status && typeof status === 'object') {
    const f = status.filled as { totalSz?: unknown; avgPx?: unknown; oid?: unknown } | undefined;
    if (f && typeof f.totalSz === 'string' && typeof f.avgPx === 'string' && typeof f.oid === 'number') return { kind: 'filled', totalSz: f.totalSz, avgPx: f.avgPx, oid: f.oid };
    const r = status.resting as { oid?: unknown } | undefined;
    if (r && typeof r.oid === 'number') return { kind: 'resting', oid: r.oid };
    if (typeof status.error === 'string') return { kind: 'error', message: status.error };
  }
  return { kind: 'error', message: 'Hyperliquid answered without an order status.' };
}
