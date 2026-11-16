/**
 * On-chain DEX prices, for display only while the US-equity session is closed. Stock Tokens are ERC-20s that keep
 * trading on Robinhood Chain pools around the clock; Robinhood's quote API freezes from Friday 20:00 to Sunday
 * 20:00 ET. The workers index the Swap events of one Stock Token / USDG pool per market (robinhood-mainnet.json
 * `dexPools`, chosen by liquidity alone; Velum names no DEX) and the API shows the last on-chain trade next to
 * the last official quote.
 *
 * Never a price source: DEX prices never reach price snapshots, quotes, candles of the quote source, the relayer,
 * the oracle or anything tradable. They live in their own tables (DexTrade, DexCandle) and Redis key.
 *
 * Price basis: a Stock Token's on-chain amount is per token (ERC-8056: uiMultiplier scales shares per token
 * without changing balances), so a swap's USDG per token is on the same basis as Robinhood's tokenBid/tokenAsk
 * (bid/ask x currentMultiplier), the basis of every Velum price. No multiplier is applied.
 */
import mainnetJson from '../robinhood-mainnet.json';
import type { Address } from './index';

export type DexPoolKind = 'cl';

export interface DexPool {
  symbol: string;
  /** Pool contract, lower case. */
  pool: Address;
  /** Concentrated-liquidity pool (Swap(address,address,int256,int256,uint160,uint128,int24)). */
  kind: DexPoolKind;
  /** Swap fee in millionths when the pool has a fixed one (null: dynamic). */
  feePpm: number | null;
  /** Whether USDG is the pool's token0 (token order is by address). */
  usdgIsToken0: boolean;
}

/** Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick). */
export const DEX_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

type PoolJson = { pool: string; kind: string; feePpm: number | null; usdgIsToken0: boolean };

type TokenJson = { address: string; decimals: number };
const mainnetTokens = (mainnetJson as unknown as { tokens: Record<string, TokenJson> }).tokens;

/** A mainnet token's address (lower case) and decimals, by symbol (USDG or a Stock Token), or null. */
export function dexToken(symbol: string): { address: string; decimals: number } | null {
  const t = mainnetTokens[symbol];
  return t ? { address: t.address.toLowerCase(), decimals: t.decimals } : null;
}

/** The configured pools of a network: mainnet only (testnet has no Stock Token pools to show). */
export function dexPoolsOf(network: 'testnet' | 'mainnet'): Record<string, DexPool> {
  if (network !== 'mainnet') return {};
  const raw = (mainnetJson as unknown as { dexPools?: Record<string, PoolJson | string> }).dexPools ?? {};
  const out: Record<string, DexPool> = {};
  for (const [symbol, v] of Object.entries(raw)) {
    if (symbol.startsWith('_') || typeof v !== 'object' || !/^0x[0-9a-f]{40}$/.test(v.pool) || v.kind !== 'cl') continue;
    out[symbol] = { symbol, pool: v.pool as Address, kind: 'cl', feePpm: v.feePpm ?? null, usdgIsToken0: v.usdgIsToken0 === true };
  }
  return out;
}

/**
 * Guards and thresholds (owner brief of 2026-11-15). Amounts are USDG decimal strings.
 *  - minLiquidityUsdg / minSideUsdg: a pool shows only while it holds at least this much in total and on each
 *    side (USDG, and tokens valued at the last trade); below, it is flagged and the API falls back to the last
 *    session's change and the session-break chart.
 *  - dustUsdg: trades below this notional are ignored (they move a thin pool for nothing).
 *  - quoteBoundBps: a trade more than this far from the last official quote is ignored (Robinhood's own jump
 *    guard uses the same 25%).
 *  - medianWindow / medianBoundBps: a trade more than this far from the median of the last `medianWindow`
 *    non-dust trades within the quote bound (itself included) is ignored: one outlier never moves the median,
 *    a real move does once it is the majority of the window.
 */
export const DEX_PARAMS = {
  minLiquidityUsdg: '50000',
  minSideUsdg: '2500',
  dustUsdg: '25',
  quoteBoundBps: 2500n,
  medianWindow: 9,
  medianBoundBps: 300n,
  /** The API shows DEX data only while the workers confirmed it this recently. */
  staleAfterMs: 10 * 60_000,
  /** ...and the pool's liquidity was read this recently. */
  liquidityStaleAfterMs: 30 * 60_000,
  /**
   * The pool's close price is its last trade before the session's end, at most this long before it. A pool's price
   * only moves with swaps, so the last trade is the pool's price at the close however long ago it was; the bound
   * only keeps an unindexed gap from reaching back days.
   */
  closeWindowMs: 24 * 3_600_000,
} as const;

const WAD = 10n ** 18n;
const scale = (raw: bigint, decimals: number): bigint => (decimals <= 18 ? raw * 10n ** BigInt(18 - decimals) : raw / 10n ** BigInt(decimals - 18));
const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/** A decimal string as a wad (18 decimals, exact; at most 18 fraction digits), or null. */
export function decToWad(s: string): bigint | null {
  const m = /^(\d{1,30})(?:\.(\d{1,18}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]!) * WAD + BigInt((m[2] ?? '').padEnd(18, '0'));
}

/** A wad as a plain decimal string (trailing zeros trimmed). */
export function wadToDec(w: bigint): string {
  const neg = w < 0n;
  const a = abs(w);
  const int = a / WAD;
  const frac = (a % WAD).toString().padStart(18, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

export interface DexTradePrice {
  /** USDG per token, wad, rounded down. */
  price: bigint;
  /** Tokens traded, wad. */
  qty: bigint;
  /** USDG traded, wad. */
  notional: bigint;
  /** The trader's side: 'buy' when tokens left the pool. */
  side: 'buy' | 'sell';
}

/**
 * Price of one swap from its signed pool deltas (positive: into the pool), exact: USDG per token = |usdg| / |tokens|
 * with both scaled to 18 decimals (USDG has 6, Stock Tokens 18). Null when either side is zero or both moved the
 * same way (not a swap a price can be read from).
 */
export function dexTradePrice(amount0: bigint, amount1: bigint, usdgIsToken0: boolean, stockDecimals = 18, usdgDecimals = 6): DexTradePrice | null {
  const usdgRaw = usdgIsToken0 ? amount0 : amount1;
  const stockRaw = usdgIsToken0 ? amount1 : amount0;
  if (usdgRaw === 0n || stockRaw === 0n || usdgRaw > 0n === stockRaw > 0n) return null;
  const notional = scale(abs(usdgRaw), usdgDecimals);
  const qty = scale(abs(stockRaw), stockDecimals);
  if (qty === 0n) return null;
  return { price: (notional * WAD) / qty, qty, notional, side: stockRaw < 0n ? 'buy' : 'sell' };
}

/** Median of wads (the lower middle for an even count, so it is always one of the values). */
export function medianWad(values: readonly bigint[]): bigint | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor((s.length - 1) / 2)]!;
}

export type DexTradeStatus = 'ok' | 'dust' | 'quoteBound' | 'median';

/** |a / b - 1| > bps / 10,000, exactly. */
const outside = (a: bigint, b: bigint, bps: bigint): boolean => b > 0n && abs(a - b) * 10_000n > b * bps;

/**
 * Why a trade is not shown, or 'ok'. `quote`: the last official quote (token basis), null when there is none.
 * `window`: prices of the previous non-dust trades within the quote bound, oldest first (the last
 * medianWindow - 1 are used, with this trade). The median check starts once three trades are in the window.
 */
export function classifyDexTrade(t: Pick<DexTradePrice, 'price' | 'notional'>, quote: bigint | null, window: readonly bigint[], p = DEX_PARAMS): DexTradeStatus {
  if (t.notional < decToWad(p.dustUsdg)!) return 'dust';
  if (quote !== null && quote > 0n && outside(t.price, quote, p.quoteBoundBps)) return 'quoteBound';
  const w = [...window.slice(-(p.medianWindow - 1)), t.price];
  const m = w.length >= 3 ? medianWad(w) : null;
  if (m !== null && outside(t.price, m, p.medianBoundBps)) return 'median';
  return 'ok';
}

/** Whether a pool's liquidity passes the thresholds: total and each side in USDG (wads). */
export function dexLiquidityOk(usdgSide: bigint, tokenSideUsdg: bigint, p = DEX_PARAMS): boolean {
  const min = decToWad(p.minLiquidityUsdg)!;
  const side = decToWad(p.minSideUsdg)!;
  return usdgSide + tokenSideUsdg >= min && usdgSide >= side && tokenSideUsdg >= side;
}

/** What the workers publish per market (Redis, authenticated like every value there). Decimal strings. */
export interface DexSnapshot {
  symbol: string;
  pool: string;
  /** Last trade that passed the guards: USDG per token. */
  price: string;
  /** Its block time and block. */
  tradeAt: number;
  block: number;
  /** Liquidity held by the pool in USDG (both sides, tokens at the last trade), and each side. */
  liquidityUsdg: string;
  usdgSide: string;
  tokenSideUsdg: string;
  /** The pool is below the liquidity thresholds (not shown). */
  belowThreshold: boolean;
  /** When the liquidity was read, and when the indexer last ran for this pool. */
  liquidityAt: number;
  checkedAt: number;
  /**
   * The pool's price at the last session's close: the last trade that passed the guards at or before the session's
   * end (20:00 ET), within DEX_PARAMS.closeWindowMs before it; `end` names that session. The DEX change
   * since the close compares the pool with itself, so a standing gap between the pool and the official quote is not
   * shown as a move. null when the pool did not trade near the close.
   */
  close: { end: number; price: string; at: number } | null;
}

export const DEX_CACHE_KEY = (symbol: string) => `velum:dex:${symbol}`;
export const MAX_DEX_SNAPSHOT_BYTES = 2048;

const DEC = /^\d{1,15}(\.\d{1,18})?$/;
const isDec = (v: unknown): v is string => typeof v === 'string' && DEC.test(v);
const isTime = (v: unknown, now: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= now + 30_000;

/** A DEX snapshot read from Redis for `symbol` and `pool`, or null when malformed, oversized, for another pool or future-dated. */
export function parseDexSnapshot(raw: unknown, symbol: string, pool: string, now: number): DexSnapshot | null {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_DEX_SNAPSHOT_BYTES) return null;
  let v: Partial<DexSnapshot>;
  try {
    v = JSON.parse(raw) as Partial<DexSnapshot>;
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || v.symbol !== symbol || v.pool !== pool) return null;
  if (!isDec(v.price) || !/[1-9]/.test(v.price) || !isDec(v.liquidityUsdg) || !isDec(v.usdgSide) || !isDec(v.tokenSideUsdg)) return null;
  if (!isTime(v.tradeAt, now) || !isTime(v.liquidityAt, now) || !isTime(v.checkedAt, now)) return null;
  if (typeof v.block !== 'number' || !Number.isSafeInteger(v.block) || v.block <= 0 || typeof v.belowThreshold !== 'boolean') return null;
  const c = v.close as { end?: unknown; price?: unknown; at?: unknown } | null | undefined;
  let close: DexSnapshot['close'] = null;
  if (c !== null && c !== undefined) {
    if (typeof c !== 'object' || !isDec(c.price) || !/[1-9]/.test(c.price) || !isTime(c.end, now + 7 * 86_400_000) || !isTime(c.at, now) || c.at > c.end) return null;
    close = { end: c.end, price: c.price, at: c.at };
  }
  return {
    symbol,
    pool,
    price: v.price,
    tradeAt: v.tradeAt,
    block: v.block,
    liquidityUsdg: v.liquidityUsdg,
    usdgSide: v.usdgSide,
    tokenSideUsdg: v.tokenSideUsdg,
    belowThreshold: v.belowThreshold,
    liquidityAt: v.liquidityAt,
    checkedAt: v.checkedAt,
    close,
  };
}

/** DEX candle timeframes the workers build (the daily view aggregates the hourly ones per closed period). */
export const DEX_TIMEFRAMES = ['15m', '1h', '4h'] as const;
export type DexTimeframe = (typeof DEX_TIMEFRAMES)[number];
