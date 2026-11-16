/**
 * Real perps on mainnet through Hyperliquid: the Stock Token markets of the "xyz" builder-deployed perp dex
 * (HIP-3, by trade.xyz), traded from the user's own Hyperliquid account through its public API (no key, no Velum
 * capital: the venue's market makers are the counterparty). Velum is a frontend: it never holds funds, the user's
 * wallet approves a browser-held agent key once, and every order is the user's.
 *
 * Checked 2026-11-16 against the live API (api.hyperliquid.xyz) and the official docs (hyperliquid.gitbook.io):
 *  - perpDexs lists [null, xyz, ...]: xyz is perp dex index 1; its collateral token is 0 (USDC).
 *  - Builder-deployed asset id = 100000 + perp_dex_index * 10000 + index_in_meta (docs, "Asset IDs"); the indices
 *    below are each market's index in meta({ dex: "xyz" }), all with szDecimals 3. The web re-reads meta and refuses a
 *    market whose name at the pinned index is not the expected coin.
 *  - PLTR, COIN, AMD and NFLX are isolated-only (onlyIsolated, marginMode "noCross"); Velum trades every market
 *    isolated (each position's margin is its own, losses stop there).
 *  - Leverage is an integer (updateLeverage "integer representing new leverage"); Velum allows 1x to 5x (CLAUDE.md §5).
 *  - Orders below 10 USD notional are refused ("Order must have minimum value of $10").
 *  - metaAndAssetCtxs `funding` is the hourly rate as a fraction (funding is paid hourly; TSLA 0.00000625 x 8 equals the
 *    8-hour figure an aggregator reported), `openInterest` is in coins (one side), `markPx` and `oraclePx` in USDC.
 * Pure and dependency-free: the workers, the API and the web share it. Import it as '@velum/config/src/hyperliquid'.
 */

export const HL_API = 'https://api.hyperliquid.xyz';
export const HL_APP = 'https://app.hyperliquid.xyz';
export const HL_VENUE = 'hyperliquid' as const;
export const HL_DEX = 'xyz';
export const HL_DEX_INDEX = 1;
/** USDC on Hyperliquid (spotMeta token 0), as sendAsset names it. */
export const HL_USDC_TOKEN = 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054';
/** Velum's limits for Hyperliquid positions: CLAUDE.md §5 (max 5x, at most 100 tokens per position). */
export const HL_MAX_LEVERAGE = 5;
export const HL_MAX_TOKENS = 100;
/** Hyperliquid's minimum order value (USD). */
export const HL_MIN_ORDER_USD = 10;
/** Hyperliquid caps funding at 0.5% per hour: anything beyond is not a funding rate. */
export const HL_MAX_FUNDING_PCT = 0.5;

export interface HlMarket {
  symbol: string;
  /** The coin name in the xyz dex, e.g. "xyz:TSLA". */
  coin: string;
  /** Index in meta({ dex: "xyz" }).universe. */
  index: number;
  /** Order asset id: 100000 + HL_DEX_INDEX * 10000 + index. */
  asset: number;
  szDecimals: number;
  /** The venue allows cross margin on this market (Velum still trades it isolated). */
  crossAllowed: boolean;
  /**
   * The venue's maximum leverage on this market (Velum caps at HL_MAX_LEVERAGE). Hyperliquid's maintenance margin is half
   * the initial margin at this leverage, so it sets the liquidation price. Pinned: 10 (the lowest of the Velum markets on
   * 2026-11-16, so the most cautious estimate) until meta confirms the live value.
   */
  maxLeverage: number;
}

const PINNED: Array<[string, number, boolean]> = [
  ['TSLA', 1, true],
  ['NVDA', 2, true],
  ['PLTR', 6, false],
  ['COIN', 7, false],
  ['META', 8, true],
  ['AAPL', 9, true],
  ['MSFT', 10, true],
  ['AMZN', 13, true],
  ['AMD', 14, false],
  ['NFLX', 19, false],
];

export const hlAssetId = (index: number): number => 100000 + HL_DEX_INDEX * 10000 + index;

/** Velum symbol -> its Hyperliquid xyz market. */
export const HL_MARKETS: Readonly<Record<string, HlMarket>> = Object.fromEntries(
  PINNED.map(([symbol, index, crossAllowed]) => [symbol, { symbol, coin: `${HL_DEX}:${symbol}`, index, asset: hlAssetId(index), szDecimals: 3, crossAllowed, maxLeverage: 10 }]),
);

/** The pinned market of `symbol` when `universe` (meta of the xyz dex) still lists it at its index, else null. */
export function hlCheckMarket(symbol: string, universe: unknown): HlMarket | null {
  const m = HL_MARKETS[symbol];
  if (!m || !Array.isArray(universe)) return null;
  const u = universe[m.index] as { name?: unknown; szDecimals?: unknown; isDelisted?: unknown; maxLeverage?: unknown } | undefined;
  if (!u || u.name !== m.coin || u.isDelisted === true || typeof u.szDecimals !== 'number' || !Number.isInteger(u.szDecimals) || u.szDecimals < 0 || u.szDecimals > 6) return null;
  const lev = u.maxLeverage;
  return { ...m, szDecimals: u.szDecimals, maxLeverage: typeof lev === 'number' && Number.isInteger(lev) && lev >= 1 && lev <= 100 ? lev : m.maxLeverage };
}

/** Hourly funding in percent (string, 6 decimals, signed) from Hyperliquid's hourly fraction, or null when implausible. */
export function hlHourlyFundingPct(funding: unknown): string | null {
  const f = typeof funding === 'string' && /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(funding) ? Number(funding) : NaN;
  if (!Number.isFinite(f)) return null;
  const pct = f * 100;
  if (Math.abs(pct) > HL_MAX_FUNDING_PCT) return null;
  const r = Math.round(pct * 1e6) / 1e6;
  return (Object.is(r, -0) ? 0 : r).toFixed(6);
}
