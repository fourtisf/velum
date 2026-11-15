/**
 * Single source of truth for chain constants, tokens, markets and protocol numbers.
 * robinhood-testnet.json and robinhood-mainnet.json were verified on 2026-11-14 (see their
 * _verification blocks). Numbers here mirror CLAUDE.md section 5. Change them only with sign-off.
 *
 * The network is chosen by NEXT_PUBLIC_VELUM_NETWORK (web, inlined at build) or VELUM_NETWORK
 * (api/workers): "testnet" (default) or "mainnet". Mainnet is read-only in Phase 2: wallet
 * connect and public balances are real, trades are simulated, and no Velum contract may be
 * deployed there before the Phase 5 external audit.
 */
import mainnetJson from '../robinhood-mainnet.json';
import chain from '../robinhood-testnet.json';

export type Address = `0x${string}`;
export type MarketStatus = 'live' | 'coming_soon' | 'close_only';

export interface TokenInfo {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
}

export interface MarketSeed {
  symbol: string;
  name: string;
  /** Demo seed price in USDG (decimal string). */
  seedPrice: string;
  /** Demo random-walk volatility per tick (fraction). */
  vol: number;
  /** Demo open interest in USDG. */
  openInterest: string;
  /** Funding rate per hour, in percent (0.0042 = 0.0042%). */
  fundingPerHour: string;
  status: MarketStatus;
  token: TokenInfo | null;
}

export interface PoolSeed {
  symbol: string;
  /** Demo pool size in USDG (published hourly, rounded). */
  size: string;
  /** Demo estimated APR in percent. */
  aprEst: string;
}

export type NetworkName = 'testnet' | 'mainnet';
const rawNetwork = (process.env.NEXT_PUBLIC_VELUM_NETWORK || process.env.VELUM_NETWORK || 'testnet').trim().toLowerCase();
export const NETWORK: NetworkName = rawNetwork === 'mainnet' ? 'mainnet' : 'testnet';
export const IS_MAINNET = NETWORK === 'mainnet';
export const TESTNET_CHAIN_ID = chain.network.chainId;
export const MAINNET_CHAIN_ID = mainnetJson.network.chainId;

interface NetworkJson {
  network: {
    name: string;
    chainId: number;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    rpcUrl: string;
    explorer: string;
    explorerApi: string;
    multicall3: string;
    faucets: { ethAndStockTokens?: string; usdg?: string };
  };
  tokens: Record<string, { address: string; decimals: number; name: string }>;
  priceFeeds: Record<string, string>;
}
const net: NetworkJson = IS_MAINNET ? mainnetJson : chain;

export const CHAIN = {
  id: net.network.chainId,
  name: net.network.name,
  /** Short label for copy, e.g. "Robinhood Chain testnet". */
  label: IS_MAINNET ? 'Robinhood Chain' : 'Robinhood Chain testnet',
  nativeCurrency: net.network.nativeCurrency,
  rpcUrl: net.network.rpcUrl,
  explorer: net.network.explorer,
  explorerApi: net.network.explorerApi,
  multicall3: net.network.multicall3 as Address,
  faucets: net.network.faucets,
  testnet: !IS_MAINNET,
} as const;

type TokenJson = { address: string; decimals: number; name: string };
const tokenJson = net.tokens as Record<string, TokenJson>;

export const TOKENS: Record<string, TokenInfo> = Object.fromEntries(
  Object.entries(tokenJson).map(([symbol, t]) => [
    symbol,
    { symbol, name: t.name, address: t.address as Address, decimals: t.decimals },
  ]),
);

export const QUOTE_SYMBOL = 'USDG';
export const USDG: TokenInfo = TOKENS[QUOTE_SYMBOL]!;

/** Chainlink AggregatorV3 proxies by symbol. Empty until verified against Chainlink's official list. */
export const PRICE_FEEDS: Record<string, Address> = Object.fromEntries(
  Object.entries(net.priceFeeds)
    .filter(([k, v]) => !k.startsWith('_') && /^0x[0-9a-fA-F]{40}$/.test(v))
    .map(([k, v]) => [k, v as Address]),
);

export const PROTOCOL = {
  maxLeverage: chain.protocol.maxLeverage,
  leverageStep: chain.protocol.leverageStep,
  maintenanceMarginFactor: chain.protocol.maintenanceMarginFactor,
  takerFeeBps: chain.protocol.takerFeeBps,
  liquidationPenaltyBps: chain.protocol.liquidationPenaltyBps,
  spotPoolFeeBps: chain.protocol.spotPoolFeeBps,
  maxTokensPerPosition: chain.protocol.maxTokensPerPosition,
  makerFillWindowMinutes: chain.protocol.makerFillWindowMinutes,
  forcedExitDelayDays: chain.protocol.forcedExitDelayDays,
  forcedExitBondEth: chain.protocol.forcedExitBondEth,
  oracleMaxAgeSeconds: chain.protocol.oracleMaxAgeSeconds,
  oracleDeadAfterDays: chain.protocol.oracleDeadAfterDays,
  maxFundingPerHourPct: chain.protocol.maxFundingPerHourPct,
  defaultSlippagePct: chain.protocol.defaultSlippagePct,
  slippageOptionsPct: [0.1, 0.5, 1] as const,
  publicAggregate: chain.protocol.publicAggregate,
} as const;

/**
 * Demo-only pricing knobs taken from the prototype (spec section 6). They model a maker's
 * open spread and pool price impact until real contracts exist (Phase 3).
 */
export const DEMO = {
  makerOpenSpreadBps: 5,
  priceImpactBps: 8,
  /** Mark price premium over the index price shown in the chart stats. */
  markPremiumBps: 4,
  /** Close spread a demo maker commits to, sampled per position in this range. */
  closeSpreadBpsRange: [3, 8] as const,
  shieldedValue: '4800000',
  proofsTodayBase: 18420,
} as const;

const SEED: Array<[string, string, string, number, string, string]> = [
  ['TSLA', 'Tesla', '391.65', 0.0017, '742000', '0.0042'],
  ['AMZN', 'Amazon', '233.40', 0.0011, '518000', '0.0018'],
  ['PLTR', 'Palantir', '165.85', 0.002, '466000', '0.0061'],
  ['NVDA', 'Nvidia', '186.40', 0.0016, '903000', '0.0035'],
  ['NFLX', 'Netflix', '112.30', 0.0013, '284000', '0.0027'],
  ['AMD', 'AMD', '221.60', 0.0018, '377000', '0.0049'],
  ['AAPL', 'Apple', '268.90', 0.0009, '655000', '0.0012'],
  ['META', 'Meta', '612.40', 0.0012, '431000', '0.0021'],
  ['MSFT', 'Microsoft', '508.10', 0.0008, '389000', '0.0009'],
  ['COIN', 'Coinbase', '301.70', 0.0024, '212000', '0.0068'],
];

export const MARKETS: MarketSeed[] = SEED.map(([symbol, name, seedPrice, vol, openInterest, fundingPerHour]) => {
  const token = TOKENS[symbol] ?? null;
  return { symbol, name, seedPrice, vol, openInterest, fundingPerHour, token, status: token ? 'live' : 'coming_soon' };
});

export const MARKET_SYMBOLS = MARKETS.map((m) => m.symbol);

/** Official Robinhood Stock Token quotes (docs.robinhood.com/chain/stock-token-apis), 60 req/s. */
export const ROBINHOOD_PRICES_URL = 'https://api.robinhood.com/rhj/prices';
/** Official Stock Token list with each token's corporate-action multiplier (currentMultiplier). */
export const ROBINHOOD_ASSETS_URL = 'https://api.robinhood.com/rhj/assets';
/** Mainnet token addresses, used to check that a quote is for the exact Robinhood token. */
export const MAINNET_TOKEN_ADDRESSES: Record<string, string> = Object.fromEntries(
  Object.entries(mainnetJson.tokens as Record<string, { address: string }>).map(([k, v]) => [k, v.address.toLowerCase()]),
);
export const DEFAULT_SYMBOL = 'TSLA';

export const POOLS: PoolSeed[] = [
  ['TSLA', '1200000', '14.2'],
  ['NVDA', '1500000', '11.8'],
  ['AMZN', '860000', '9.6'],
  ['PLTR', '640000', '18.4'],
  ['NFLX', '480000', '13.1'],
  ['AMD', '420000', '12.9'],
  ['AAPL', '910000', '7.3'],
  ['META', '530000', '8.8'],
  ['COIN', '310000', '21.5'],
].map(([symbol, size, aprEst]) => ({ symbol: symbol!, size: size!, aprEst: aprEst! }));

export const TIMEFRAMES = ['15m', '1h', '4h', '1D'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1D': 24 * 60 * 60_000,
};

export function getMarket(symbol: string): MarketSeed | undefined {
  return MARKETS.find((m) => m.symbol === symbol.toUpperCase());
}

export function isMarketSymbol(symbol: string): boolean {
  return MARKETS.some((m) => m.symbol === symbol.toUpperCase());
}

export function isLive(symbol: string): boolean {
  return getMarket(symbol)?.status === 'live';
}

export function explorerAddressUrl(address: string): string {
  return `${CHAIN.explorer}/address/${address}`;
}

export function explorerTxUrl(hash: string): string {
  return `${CHAIN.explorer}/tx/${hash}`;
}

export * from './cache';
export * from './redis-url';
export * from './session';
