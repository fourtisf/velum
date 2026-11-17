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

/**
 * Deposits from inside Velum. Hyperliquid's USDC bridge on Arbitrum ("Bridge2"; docs for-developers/api/usdc, read
 * 2026-11-16): "The user sends native USDC to the bridge, and it is credited to the account that sent it in less than
 * 1 minute. The minimum deposit amount is 5 USDC. If you send an amount less than this, it will not be credited and be
 * lost forever." The docs call it the legacy bridge; on 2026-11-16 it held about 58M USDC and took about 105 deposits
 * an hour (checked onchain), and it is the route Hyperliquid documents for wallet deposits ("via Arbitrum only").
 */
export const HL_BRIDGE = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7' as const;
/** Native USDC on Arbitrum One (the only token the bridge credits). */
export const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as const;
export const ARB_USDC_DECIMALS = 6;
export const ARB_CHAIN_ID = 42161;
export const ARB_RPC = 'https://arb1.arbitrum.io/rpc';
/** Velum refuses anything under Hyperliquid's 5 USDC minimum (smaller deposits are lost). */
export const HL_MIN_DEPOSIT_USDC = 5;

/**
 * Deposits from Robinhood Chain straight into the user's Hyperliquid perps balance, through Relay (relay.link), a
 * cross-chain intent network: the wallet sends ETH or USDG to Relay's depository on Robinhood Chain and a Relay solver
 * credits USDC to the same address on Hyperliquid (refunded on Robinhood Chain if it cannot be filled). Verified on
 * 2026-11-17: Relay's chains API lists Robinhood Chain (4663; ETH and USDG) and Hyperliquid (1337; "USDC (Perps)",
 * address 0x000...0 in 32 hex digits, 8 decimals); its protocol v2 depository on Robinhood Chain is the address below
 * (code present on chain; the same address Relay lists on 45 chains); live quotes were one deposit transaction to it (ETH)
 * or an exact USDG approval to it plus the deposit (USDG), about $1.25 in fees, filled in seconds. Velum checks every
 * quote against these values before the wallet is asked to sign (apps/web/lib/hyperliquid/relay.ts).
 */
export const RELAY_API = 'https://api.relay.link';
export const RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31' as const;
export const RELAY_ORIGIN_CHAIN_ID = 4663;
/** Ethereum mainnet as a second origin (ETH only): Relay lists it with the same v2 depository (checked 2026-11-17; a live
 * quote was one deposit of exactly the ETH to that address, about $1.26 in Relay fees plus Ethereum gas). */
export const RELAY_ETHEREUM_CHAIN_ID = 1;
export const RELAY_HL_CHAIN_ID = 1337;
export const RELAY_HL_USDC = '0x00000000000000000000000000000000' as const;
export const RELAY_HL_USDC_DECIMALS = 8;
/**
 * Relay quotes are fetched again right before the wallet signs. Its guaranteed minimum drifts by a few millionths
 * between quotes, so Velum goes ahead when the fresh minimum is at most this far below the one the user reviewed
 * (0.5%), and refuses anything lower.
 */
export const RELAY_REQUOTE_TOLERANCE_BPS = 50n;
/** True when a fresh Relay minimum is more than RELAY_REQUOTE_TOLERANCE_BPS below the reviewed one. */
export const requoteTooLow = (fresh: bigint, reviewed: bigint): boolean => fresh * 10_000n < reviewed * (10_000n - RELAY_REQUOTE_TOLERANCE_BPS);

/**
 * Withdrawals out of the perps account through Relay (to Robinhood Chain as USDG or ETH, or to Ethereum as ETH). A
 * Hyperliquid-origin quote is two signatures, no gas: an EIP-712 "nonce mapping" Velum posts to Relay's /authorize
 * (signed on the wallet's current chain; checked live on 2026-11-17: Relay accepts it when the body's signatureChainId
 * names that chain), then a Hyperliquid sendAsset of the USDC, with that same nonce, to Relay's Hyperliquid address
 * below. Checked on 2026-11-17: every Hyperliquid-origin quote (to Robinhood Chain and Ethereum, several amounts and
 * accounts) named this address; Hyperliquid's public ledger showed it receiving 536 sends from 475 accounts in two hours
 * and sweeping them to 0xf70da978...dbef, which Relay's chains API lists as its Hyperliquid solver. Relay debits the
 * balance the account keeps its USDC in: "spot" for unified accounts, the main perps balance ("") otherwise. Velum
 * refuses any quote that sends elsewhere (apps/web/lib/hyperliquid/withdraw.ts).
 */
export const RELAY_HL_DEPOSIT_ADDRESS = '0x66cf0aace1b4e562593bec10ec7868fba9932224' as const;
/** Velum's smallest withdrawal through Relay (USDC); Relay quoted 1 USDC out on 2026-11-17 for about $0.02. */
export const HL_MIN_RELAY_WITHDRAW_USDC = 1;
/**
 * Hyperliquid's own withdrawal (withdraw3) to Arbitrum: USDC to the same address on Arbitrum, the user's wallet signs
 * (EIP-712, no gas). Hyperliquid's docs: a 1 USDC fee, usually arriving within about 5 minutes. Velum asks for at least
 * 2 USDC so something arrives.
 */
export const HL_WITHDRAW_FEE_USDC = 1;
export const HL_MIN_ARB_WITHDRAW_USDC = 2;

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
