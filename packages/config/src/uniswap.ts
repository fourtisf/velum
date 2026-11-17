/**
 * Uniswap on Robinhood Chain mainnet: the curated pools Velum reads prices and candles from (PRICE_SOURCE=uniswap)
 * and routes real spot trades through (apps/web, from the user's own wallet). Data: ../uniswap-mainnet.json, whose
 * _verification block says how each address was checked. Pure and dependency-free (bigint math only), so the web,
 * the API and the workers share it. Import it as '@velum/config/src/uniswap'.
 *
 * Only these pools are ever used: hookless, a standard fee tier of at most 1%. Robinhood Chain also holds hundreds of
 * look-alike pools for the same pairs (fees up to 99%, arbitrary hooks); they are never read or routed through.
 */
import mainnetJson from '../robinhood-mainnet.json';
import uniswapJson from '../uniswap-mainnet.json';
import { IS_MAINNET, MAINNET_CHAIN_ID } from './index';

type Hex = `0x${string}`;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const ID_RE = /^0x[0-9a-f]{64}$/;
export const UNI_ZERO_ADDRESS: Hex = '0x0000000000000000000000000000000000000000';
/** The highest fee tier Velum accepts: 1% (fees are in hundredths of a basis point, Uniswap's unit). */
export const UNI_MAX_FEE = 10_000;

export interface UniPoolBase {
  /** Market symbol, e.g. TSLA. */
  symbol: string;
  /** Fee in hundredths of a basis point (3000 = 0.30%). */
  fee: number;
  tickSpacing: number;
  /** A deep pool whose swaps build the price and the candles; every listed pool is a routing option. */
  chart: boolean;
  /** The Stock Token (lower case). */
  stock: Hex;
  /** USDG (lower case). */
  usdg: Hex;
  /** Lower-sorted pair, as Uniswap orders it. */
  currency0: Hex;
  currency1: Hex;
  stockIsToken0: boolean;
}

export interface UniPoolV3 extends UniPoolBase {
  version: 3;
  /** The pool contract (lower case): v3Factory.getPool(stock, USDG, fee). */
  address: Hex;
}

export interface UniPoolV4 extends UniPoolBase {
  version: 4;
  /** keccak256(abi.encode(poolKey)) (lower case). */
  id: Hex;
  /** Always the zero address: no hooked pool is ever used. */
  hooks: Hex;
}

export type UniPool = UniPoolV3 | UniPoolV4;

export interface UniswapContracts {
  v3Factory: Hex;
  quoterV2: Hex;
  poolManager: Hex;
  stateView: Hex;
  v4Quoter: Hex;
  universalRouter: Hex;
  permit2: Hex;
  weth: Hex;
}

export interface UniswapConfig {
  chainId: number;
  contracts: UniswapContracts;
  /** Block the Universal Router was created at (the earliest block a Velum-routed swap can be in). */
  universalRouterCreationBlock: number;
  /** Symbol -> curated pools, deepest first. */
  pools: Record<string, UniPool[]>;
  usdg: { address: Hex; decimals: number };
  /** Symbol -> Stock Token decimals. */
  decimals: Record<string, number>;
  /** The v3 WETH/USDG pool that buying with ETH goes through first (uniswap-mainnet.json ethLeg). */
  ethLeg: { address: Hex; fee: number };
}

/** A stable short key for a pool: "v3:<address>" or "v4:<id>". */
export const poolKeyOf = (p: UniPool): string => (p.version === 3 ? `v3:${p.address}` : `v4:${p.id}`);

/** "0.30%" for a fee of 3000 (hundredths of a basis point). */
export function feePct(fee: number): string {
  const [i, f] = (fee / 10_000).toFixed(4).split('.');
  return `${i}.${f!.replace(/0+$/, '').padEnd(2, '0')}%`;
}

/** "Uniswap v3, 0.30% pool". */
export const poolLabel = (p: UniPool): string => `Uniswap v${p.version}, ${feePct(p.fee)} pool`;

interface RawPool {
  version: number;
  address?: string;
  id?: string;
  fee: number;
  tickSpacing: number;
  chart: boolean;
}

interface RawUniswap {
  chainId: number;
  contracts: Record<string, string>;
  ethLeg: { version: number; address: string; fee: number };
  universalRouterCreationBlock: number;
  pools: Record<string, RawPool[]>;
}

/**
 * Validates and types the curated data. Throws on anything off (it is static data, checked by tests): a contract or
 * pool that is not a lower-case address or id, a fee above 1%, a symbol that is not a mainnet Stock Token, a market
 * without a chart pool, a duplicate pool.
 */
export function buildUniswap(raw: RawUniswap, tokens: Record<string, { address: string; decimals: number }>): UniswapConfig {
  const fail = (msg: string): never => {
    throw new Error(`uniswap-mainnet.json: ${msg}`);
  };
  if (raw.chainId !== MAINNET_CHAIN_ID) fail(`chainId ${raw.chainId} is not Robinhood Chain mainnet (${MAINNET_CHAIN_ID})`);
  const names: Array<keyof UniswapContracts> = ['v3Factory', 'quoterV2', 'poolManager', 'stateView', 'v4Quoter', 'universalRouter', 'permit2', 'weth'];
  const contracts = {} as UniswapContracts;
  for (const n of names) {
    const v = raw.contracts[n];
    if (typeof v !== 'string' || !ADDRESS_RE.test(v)) fail(`contracts.${n} must be a lower-case address`);
    contracts[n] = v as Hex;
  }
  const usdgRaw = tokens.USDG ?? fail('no USDG token');
  const usdg = { address: usdgRaw.address.toLowerCase() as Hex, decimals: usdgRaw.decimals };
  const decimals: Record<string, number> = {};
  const pools: Record<string, UniPool[]> = {};
  const seen = new Set<string>();
  for (const [symbol, list] of Object.entries(raw.pools)) {
    const tok = tokens[symbol];
    if (!tok || symbol === 'USDG') fail(`${symbol} is not a mainnet Stock Token`);
    const stock = tok!.address.toLowerCase() as Hex;
    decimals[symbol] = tok!.decimals;
    const stockIsToken0 = stock < usdg.address;
    const [currency0, currency1] = stockIsToken0 ? [stock, usdg.address] : [usdg.address, stock];
    const out: UniPool[] = [];
    for (const p of list) {
      if (!Number.isInteger(p.fee) || p.fee <= 0 || p.fee > UNI_MAX_FEE) fail(`${symbol}: fee ${p.fee} is not a standard tier of at most 1%`);
      if (!Number.isInteger(p.tickSpacing) || p.tickSpacing <= 0 || p.tickSpacing > 1000) fail(`${symbol}: bad tickSpacing ${p.tickSpacing}`);
      if (typeof p.chart !== 'boolean') fail(`${symbol}: chart must be true or false`);
      const base = { symbol, fee: p.fee, tickSpacing: p.tickSpacing, chart: p.chart, stock, usdg: usdg.address, currency0, currency1, stockIsToken0 };
      let pool: UniPool;
      if (p.version === 3) {
        if (typeof p.address !== 'string' || !ADDRESS_RE.test(p.address)) fail(`${symbol}: v3 pool address must be lower case`);
        pool = { ...base, version: 3, address: p.address as Hex };
      } else if (p.version === 4) {
        if (typeof p.id !== 'string' || !ID_RE.test(p.id)) fail(`${symbol}: v4 pool id must be 32 lower-case bytes`);
        pool = { ...base, version: 4, id: p.id as Hex, hooks: UNI_ZERO_ADDRESS };
      } else return fail(`${symbol}: version must be 3 or 4`);
      const k = poolKeyOf(pool);
      if (seen.has(k)) fail(`${symbol}: duplicate pool ${k}`);
      seen.add(k);
      out.push(pool);
    }
    if (!out.some((x) => x.chart)) fail(`${symbol}: needs at least one chart pool`);
    pools[symbol] = out;
  }
  const e = raw.ethLeg;
  if (!e || e.version !== 3 || typeof e.address !== 'string' || !ADDRESS_RE.test(e.address)) fail('ethLeg must be a v3 pool with a lower-case address');
  if (!Number.isInteger(e.fee) || e.fee <= 0 || e.fee > UNI_MAX_FEE) fail(`ethLeg: fee ${e.fee} is not a standard tier of at most 1%`);
  const ethLeg = { address: e.address as Hex, fee: e.fee };
  return { chainId: raw.chainId, contracts, universalRouterCreationBlock: raw.universalRouterCreationBlock, pools, usdg, decimals, ethLeg };
}

/** The curated mainnet data (always built, so tests on any network check it). */
export const UNISWAP_MAINNET: UniswapConfig = buildUniswap(uniswapJson as RawUniswap, mainnetJson.tokens);

/** Uniswap on the network this build runs on: mainnet only (there is no curated testnet venue). */
export const UNISWAP: UniswapConfig | null = IS_MAINNET ? UNISWAP_MAINNET : null;

const Q192 = 1n << 192n;
const WAD = 10n ** 18n;
/** Largest sqrtPriceX96 Uniswap allows (TickMath.MAX_SQRT_PRICE); anything above is not a pool price. */
export const UNI_MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
/** Smallest sqrtPriceX96 Uniswap allows (TickMath.MIN_SQRT_PRICE). */
export const UNI_MIN_SQRT_PRICE = 4295128739n;

/**
 * USDG per Stock Token as a wad (1e18), rounded down, from a pool's sqrtPriceX96 (the marginal price, before fees).
 * sqrtPriceX96^2 / 2^192 is token1 per token0 in base units; the decimals of the two tokens scale it. Returns null for
 * a sqrtPrice outside Uniswap's range or a price that rounds to zero.
 */
export function sqrtPriceToWad(sqrtPriceX96: bigint, stockIsToken0: boolean, stockDecimals: number, usdgDecimals: number): bigint | null {
  if (sqrtPriceX96 < UNI_MIN_SQRT_PRICE || sqrtPriceX96 > UNI_MAX_SQRT_PRICE) return null;
  const sq = sqrtPriceX96 * sqrtPriceX96;
  const shift = stockDecimals - usdgDecimals;
  const up = shift >= 0 ? 10n ** BigInt(shift) : 1n;
  const down = shift < 0 ? 10n ** BigInt(-shift) : 1n;
  // stock = token0: USDG(base) per stock(base) = sq / 2^192.  stock = token1: = 2^192 / sq.
  const w = stockIsToken0 ? (sq * up * WAD) / (Q192 * down) : (Q192 * up * WAD) / (sq * down);
  return w > 0n ? w : null;
}

/**
 * In-range USDG depth of a pool at its current price, in USDG base units: the USDG side of the virtual reserves
 * (L * sqrtP for USDG = token1, L / sqrtP for USDG = token0). A comparable measure of how much a pool can absorb
 * near the current price, used to pick the deepest chart pool.
 */
export function virtualUsdgDepth(liquidity: bigint, sqrtPriceX96: bigint, stockIsToken0: boolean): bigint {
  if (liquidity <= 0n || sqrtPriceX96 <= 0n) return 0n;
  const Q96 = 1n << 96n;
  return stockIsToken0 ? (liquidity * sqrtPriceX96) / Q96 : (liquidity * Q96) / sqrtPriceX96;
}
