/**
 * Uniswap on Robinhood Chain mainnet (PRICE_SOURCE=uniswap): Stock Tokens trade there 24/7, so the price and the
 * candles keep moving on weekends and US holidays, unlike the official Robinhood quote (24/5, frozen while closed).
 *
 * - Price: every tick, one multicall reads the current state of each market's chart pools (packages/config
 *   uniswap-mainnet.json, `chart: true`) plus the block time; the price is the marginal price of the pool with the most
 *   in-range USDG depth, rounded down to 4 decimals. A pool with less than UNI_MIN_DEPTH in range is never used, a
 *   jump of more than RH_JUMP_BPS needs RH_JUMP_CONFIRMATIONS agreeing ticks (the same guard as the Robinhood source),
 *   and a block older than PROTOCOL.oracleMaxAgeSeconds (a lagging RPC) gives no price.
 * - Swaps: getSwapLogs reads the Swap events of the chart pools for jobs/dex-candles.ts, which builds the candles from
 *   them (each swap's post-trade pool price, bucketed by its block's timestamp).
 *
 * Only the curated pools are ever read: hookless, fee tier at most 1%. Look-alike pools are ignored.
 */
import { CHAIN, MARKETS, PROTOCOL } from '@velum/config';
import { sqrtPriceToWad, virtualUsdgDepth, type UniPool, type UniswapConfig } from '@velum/config/src/uniswap';
import { roundTo, toDecimalString } from '@velum/math';
import { createPublicClient, defineChain, http, parseAbi, parseAbiItem, type Hex, type PublicClient } from 'viem';
import type { Logger } from '../lib/log';
import { redactUrls } from '../lib/redact';
import { MAX_PRICE_WAD, jumpGuard, type PriceReader } from './robinhood';

export const V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
]);
export const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
]);
export const MULTICALL3_ABI = parseAbi(['function getCurrentBlockTimestamp() view returns (uint256 timestamp)']);
export const V3_SWAP_EVENT = parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)');
export const V4_SWAP_EVENT = parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)');

/** A chart pool with less USDG than this in range at its current price (1,000 USDG, base units) never sets the price. */
export const UNI_MIN_DEPTH = 1_000n * 10n ** 6n;
/** A block dated further ahead of this machine's clock than this is not trusted (clock skew allowance). */
export const UNI_MAX_FUTURE_MS = 30_000;

/** HTTP requests in flight at once to RPC_URL (the public RPC answers bursts with 429; sequential calls are fine). */
export const RPC_MAX_IN_FLIGHT = 2;

/** A fetch that keeps at most `max` requests in flight (later ones wait their turn). */
export function limitedFetch(max: number, inner: typeof fetch = fetch): typeof fetch {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (input, init) => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await inner(input, init);
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * The chain client for Uniswap reads: small JSON-RPC batches, at most RPC_MAX_IN_FLIGHT requests at once, a 20 s
 * timeout and retries with exponential backoff (viem retries HTTP 429 and JSON-RPC 429).
 */
export function uniswapClient(rpcUrl: string): PublicClient {
  return createPublicClient({
    chain: defineChain({ id: CHAIN.id, name: CHAIN.name, nativeCurrency: CHAIN.nativeCurrency, rpcUrls: { default: { http: [rpcUrl] } }, contracts: { multicall3: { address: CHAIN.multicall3 } } }),
    transport: http(rpcUrl, { batch: { batchSize: 10, wait: 2 }, timeout: 20_000, retryCount: 6, retryDelay: 400, fetchFn: limitedFetch(RPC_MAX_IN_FLIGHT) }),
  }) as PublicClient;
}

/** The chart pools of every live market that has curated pools: symbol -> pools. */
export function chartPools(cfg: UniswapConfig): Map<string, UniPool[]> {
  const out = new Map<string, UniPool[]>();
  for (const m of MARKETS) {
    const list = (cfg.pools[m.symbol] ?? []).filter((p) => p.chart);
    if (m.status === 'live' && list.length) out.set(m.symbol, list);
  }
  return out;
}

/** The state of one pool read this tick. */
export interface PoolState {
  pool: UniPool;
  sqrtPriceX96: bigint;
  liquidity: bigint;
}

/**
 * The market price from the pools' states: the pool with the most in-range USDG depth (at least UNI_MIN_DEPTH), its
 * marginal price rounded down to 4 decimals, as a decimal string; null when no pool qualifies or the price is out of
 * (0, 1e9) USDG. Pure, for tests.
 */
export function priceFromPools(states: readonly PoolState[], stockDecimals: number, usdgDecimals: number): { price: string; pool: UniPool } | null {
  let best: { depth: bigint; s: PoolState } | null = null;
  for (const s of states) {
    const depth = virtualUsdgDepth(s.liquidity, s.sqrtPriceX96, s.pool.stockIsToken0);
    if (depth < UNI_MIN_DEPTH) continue;
    if (!best || depth > best.depth) best = { depth, s };
  }
  if (!best) return null;
  const w = sqrtPriceToWad(best.s.sqrtPriceX96, best.s.pool.stockIsToken0, stockDecimals, usdgDecimals);
  if (w === null) return null;
  const r = roundTo(w, 4, 'floor');
  if (r <= 0n || r >= MAX_PRICE_WAD) return null;
  return { price: toDecimalString(r), pool: best.s.pool };
}

type Call = { address: Hex; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

/** The Uniswap price source. `chainOk` false (RPC_URL serves another chain) reads nothing: every market goes stale. */
export function uniswapSource(client: Pick<PublicClient, 'multicall'>, cfg: UniswapConfig, log: Logger, chainOk: () => boolean = () => true): PriceReader {
  const accept = jumpGuard();
  const quoteTimes = new Map<string, number>();
  const markets = chartPools(cfg);
  return {
    name: 'uniswap',
    quoteTimes,
    async read(last, now) {
      const out = new Map<string, string>();
      if (!chainOk()) return out;
      const calls: Call[] = [{ address: CHAIN.multicall3, abi: MULTICALL3_ABI, functionName: 'getCurrentBlockTimestamp' }];
      const index: Array<{ symbol: string; pool: UniPool; at: number }> = [];
      for (const [symbol, pools] of markets) {
        for (const pool of pools) {
          index.push({ symbol, pool, at: calls.length });
          if (pool.version === 3) calls.push({ address: pool.address, abi: V3_POOL_ABI, functionName: 'slot0' }, { address: pool.address, abi: V3_POOL_ABI, functionName: 'liquidity' });
          else calls.push({ address: cfg.contracts.stateView, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [pool.id] }, { address: cfg.contracts.stateView, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [pool.id] });
        }
      }
      let res: Array<{ status: 'success' | 'failure'; result?: unknown }>;
      try {
        res = (await client.multicall({ contracts: calls as never, allowFailure: true, multicallAddress: CHAIN.multicall3 })) as typeof res;
      } catch (err) {
        log.warn('uniswap state read failed', { err: redactUrls(err instanceof Error ? err.message : String(err)) });
        return out;
      }
      const ts = res[0]?.status === 'success' ? Number(res[0].result as bigint) * 1000 : NaN;
      if (!Number.isSafeInteger(ts) || ts <= 0 || ts - now > UNI_MAX_FUTURE_MS || now - ts > PROTOCOL.oracleMaxAgeSeconds * 1000) {
        log.warn('uniswap read skipped: the RPC block time is not current', { blockTime: Number.isFinite(ts) ? new Date(ts).toISOString() : String(ts) });
        return out;
      }
      const states = new Map<string, PoolState[]>();
      for (const { symbol, pool, at } of index) {
        const s0 = res[at];
        const liq = res[at + 1];
        if (s0?.status !== 'success' || liq?.status !== 'success') continue;
        const sqrtPriceX96 = (s0.result as readonly [bigint])[0];
        const liquidity = liq.result as bigint;
        if (typeof sqrtPriceX96 !== 'bigint' || typeof liquidity !== 'bigint') continue;
        states.set(symbol, [...(states.get(symbol) ?? []), { pool, sqrtPriceX96, liquidity }]);
      }
      for (const [symbol, list] of states) {
        const p = priceFromPools(list, cfg.decimals[symbol]!, cfg.usdg.decimals);
        if (!p) {
          log.debug('uniswap: no chart pool deep enough', { symbol });
          continue;
        }
        if (!accept(symbol, p.price, last.get(symbol))) {
          log.warn('uniswap price held: large jump awaiting confirmation', { symbol, price: p.price, last: last.get(symbol) });
          continue;
        }
        out.set(symbol, p.price);
        quoteTimes.set(symbol, ts);
      }
      return out;
    },
  };
}

/** One swap of a chart pool, reduced to what the candles need. */
export interface DexSwap {
  symbol: string;
  block: bigint;
  logIndex: number;
  /** Post-trade pool price (sqrtPriceX96 of the event). */
  sqrtPriceX96: bigint;
  stockIsToken0: boolean;
}

/** Above this many blocks a getLogs with several addresses or topic values is refused by the public RPC (100k). */
export const MULTI_VALUE_SPAN = 90_000n;
/** Above this many blocks a single-pool getLogs is refused by the public RPC (10M). */
export const SINGLE_VALUE_SPAN = 9_000_000n;
/** Splitting a refused getLogs range stops below this many blocks (then the error is real). */
const MIN_SPLIT_SPAN = 64n;

/**
 * getLogs over [from, to] through `fetch`, halving the range on any error (a provider's range or result-size limit)
 * down to MIN_SPLIT_SPAN blocks. Ranges are fetched in order, so the result stays in block order per call.
 */
export async function logsAdaptive<T>(fetch: (from: bigint, to: bigint) => Promise<T[]>, from: bigint, to: bigint): Promise<T[]> {
  try {
    return await fetch(from, to);
  } catch (err) {
    if (to - from < MIN_SPLIT_SPAN) throw err;
    const mid = from + (to - from) / 2n;
    const a = await logsAdaptive(fetch, from, mid);
    const b = await logsAdaptive(fetch, mid + 1n, to);
    return a.concat(b);
  }
}

type SwapLog = { address: Hex; blockNumber: bigint | null; logIndex: number | null; removed?: boolean; args: { id?: Hex; sqrtPriceX96?: bigint } };

/**
 * Swap events of `pools` in [from, to], oldest first (block, then log index). Short ranges use two calls (every v3
 * pool address, every v4 pool id); longer ones one call per pool, each split further on a refusal. Logs that do not
 * belong to a listed pool, removed logs and malformed ones are dropped.
 */
export async function getSwapLogs(client: Pick<PublicClient, 'getLogs'>, cfg: UniswapConfig, pools: readonly UniPool[], from: bigint, to: bigint): Promise<DexSwap[]> {
  if (to < from || !pools.length) return [];
  const v3 = pools.filter((p): p is Extract<UniPool, { version: 3 }> => p.version === 3);
  const v4 = pools.filter((p): p is Extract<UniPool, { version: 4 }> => p.version === 4);
  const byAddress = new Map(v3.map((p) => [p.address, p]));
  const byId = new Map(v4.map((p) => [p.id, p]));
  const pm = cfg.contracts.poolManager;
  const v3Fetch = (addr: Hex | Hex[]) => (a: bigint, b: bigint) => client.getLogs({ address: addr, event: V3_SWAP_EVENT, fromBlock: a, toBlock: b }) as Promise<SwapLog[]>;
  const v4Fetch = (id: Hex | Hex[]) => (a: bigint, b: bigint) => client.getLogs({ address: pm, event: V4_SWAP_EVENT, args: { id }, fromBlock: a, toBlock: b }) as Promise<SwapLog[]>;
  // Batches of logs, never spread into one array (a busy range holds hundreds of thousands of swaps).
  const raw: SwapLog[][] = [];
  if (to - from <= MULTI_VALUE_SPAN) {
    if (v3.length) raw.push(await logsAdaptive(v3Fetch(v3.length === 1 ? v3[0]!.address : v3.map((p) => p.address)), from, to));
    if (v4.length) raw.push(await logsAdaptive(v4Fetch(v4.length === 1 ? v4[0]!.id : v4.map((p) => p.id)), from, to));
  } else {
    for (let a = from; a <= to; a += SINGLE_VALUE_SPAN) {
      const b = a + SINGLE_VALUE_SPAN - 1n < to ? a + SINGLE_VALUE_SPAN - 1n : to;
      for (const p of v3) raw.push(await logsAdaptive(v3Fetch(p.address), a, b));
      for (const p of v4) raw.push(await logsAdaptive(v4Fetch(p.id), a, b));
    }
  }
  const out: DexSwap[] = [];
  for (const l of raw.flat()) {
    if (l.removed || l.blockNumber === null || l.logIndex === null || typeof l.args?.sqrtPriceX96 !== 'bigint') continue;
    const addr = l.address.toLowerCase() as Hex;
    const pool = addr === pm ? (l.args.id ? byId.get(l.args.id.toLowerCase() as Hex) : undefined) : byAddress.get(addr);
    if (!pool) continue;
    out.push({ symbol: pool.symbol, block: l.blockNumber, logIndex: l.logIndex, sqrtPriceX96: l.args.sqrtPriceX96, stockIsToken0: pool.stockIsToken0 });
  }
  out.sort((x, y) => (x.block === y.block ? x.logIndex - y.logIndex : x.block < y.block ? -1 : 1));
  return out;
}
