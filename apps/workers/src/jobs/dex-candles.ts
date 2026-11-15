/**
 * Candles from real Uniswap swaps (PRICE_SOURCE=uniswap). Stock Tokens trade on Uniswap on Robinhood Chain around the
 * clock, so these candles move on weekends and US holidays too, and every high and low is a price a swap actually
 * left a pool at.
 *
 * - Each swap of a chart pool (packages/config uniswap-mainnet.json, `chart: true`) is one tick: the pool's price after
 *   the swap (sqrtPriceX96 of the event, before fees), rounded down to 4 decimals, in the bucket of its block's
 *   timestamp (lib/block-clock.ts: exact to the second, a few header reads per bucket boundary between swaps).
 * - Two cursors, each an IndexerCheckpoint row: `live` follows the chain head (DEX_CONFIRMATIONS behind) and `history`
 *   walks backwards from where live started, so the newest candles fill first and a chart is usable within a minute
 *   of a fresh start while older history keeps arriving. Stored candles always cover exactly the blocks
 *   (history, live]: live rows are newer than anything stored and merge as 'append', history rows older and merge as
 *   'prepend' (lib/candles.ts candleMergeSql), so the result is the same whatever order they ran in.
 * - A jump of more than RH_JUMP_BPS needs RH_JUMP_CONFIRMATIONS agreeing swaps (the price source's guard), so a single
 *   manipulated swap never paints a wick. Live: against the last accepted price. History: against the median price of
 *   the market in the block range at hand.
 * - Each block range writes its buckets and moves its checkpoint in one transaction (only from where this process
 *   left it); memory and the Redis cache follow the commit.
 * - First start, a changed set of chart pools (new checkpoint keys), or a live checkpoint whose block hash the chain no
 *   longer has: every uniswap candle and DEX checkpoint is removed and both cursors start at the head.
 */
import { createHash } from 'node:crypto';
import { CANDLE_CACHE_SIZE, TIMEFRAMES, TIMEFRAME_MS, cacheKeys, type Timeframe } from '@velum/config';
import { poolKeyOf, sqrtPriceToWad, type UniPool, type UniswapConfig } from '@velum/config/src/uniswap';
import { roundTo, toDecimalString, wmax, wmin, type Wad } from '@velum/math';
import type { PublicClient } from 'viem';
import { BlockClock, type BlockHeader } from '../lib/block-clock';
import { CANDLE_MERGE_BATCH, bucketStart, candleMergeSql, mergeCandle, toCandle, type CandleRow, type WadCandle } from '../lib/candles';
import { MAX_PRICE_WAD, jumpGuard } from '../sources/robinhood';
import { MULTI_VALUE_SPAN, chartPools, getSwapLogs, type DexSwap } from '../sources/uniswap';
import { CANDLES_WORKER, seriesKey, type WorkerContext } from '../context';
import { writeCandleCaches } from './candles';

export const DEX_SOURCE = 'uniswap' as const;
/** IndexerCheckpoint.deployment prefixes of the two cursors (plus a fingerprint of the chart pools). */
export const DEX_LIVE_PREFIX = 'uniswap-candles:';
export const DEX_HISTORY_PREFIX = 'uniswap-history:';
/** Every DEX checkpoint key starts with this (a rebuild removes them all). */
export const DEX_KEY_PREFIX = 'uniswap-';
/** Blocks behind the head the candles stay (about 0.2 s on Robinhood Chain). */
export const DEX_CONFIRMATIONS = 2n;
/** Blocks per processed range (about 2.5 hours): one getLogs per pool kind within the public RPC's 100k limit. */
export const DEX_CHUNK = MULTI_VALUE_SPAN;
/** A step starts no new history range after this long (live ranges always run first). */
export const DEX_STEP_BUDGET_MS = 12_000;
/** Boundaries located concurrently (their header reads go out as small JSON-RPC batches). */
const BOUNDARY_GROUP = 10;

/** The checkpoint is not where this process left it (another writer, or a rebuild): nothing was written. */
export class CheckpointMoved extends Error {
  constructor() {
    super('dex candles: a checkpoint moved under this process; reloading');
  }
}

/** The chain reads the DEX candles need. */
export type DexClient = Pick<PublicClient, 'getLogs' | 'getBlockNumber' | 'getBlock'>;

/** Fingerprint of a set of chart pools: a new set gets new checkpoint keys, so its history is rebuilt. */
export function poolsFingerprint(pools: Iterable<UniPool>): string {
  const keys = [...pools].map(poolKeyOf).sort();
  return createHash('sha256').update(keys.join(',')).digest('hex').slice(0, 16);
}

/** Start (Unix ms) of the oldest bucket a timeframe keeps: CANDLE_CACHE_SIZE buckets ending with the current one. */
export const windowStart = (nowMs: number, tf: Timeframe): number => bucketStart(nowMs, tf) - (CANDLE_CACHE_SIZE - 1) * TIMEFRAME_MS[tf];
/** The oldest window start over every timeframe (Unix ms): history stops below it. */
export const oldestWindowStart = (nowMs: number): number => Math.min(...TIMEFRAMES.map((tf) => windowStart(nowMs, tf)));

/**
 * Bucket boundaries (Unix seconds) inside (fromTs, toTs] that matter for each timeframe: multiples of the timeframe
 * from its window start on. Pure, for tests.
 */
export function boundariesIn(fromTs: number, toTs: number, nowMs: number): Record<Timeframe, number[]> {
  const out = {} as Record<Timeframe, number[]>;
  for (const tf of TIMEFRAMES) {
    const step = TIMEFRAME_MS[tf] / 1000;
    const w = windowStart(nowMs, tf) / 1000;
    const list: number[] = [];
    for (let t = Math.max(w, (Math.floor(fromTs / step) + 1) * step); t <= toTs; t += step) list.push(t);
    out[tf] = list;
  }
  return out;
}

/**
 * The bucket start (Unix ms) of a swap in block `block` for a timeframe, or null when it is older than the
 * timeframe's window. `baseTs` is the timestamp of a block at or before `block` (the reference the boundaries were
 * located from); `located` the timeframe's boundaries after it, ascending, each with the first block at or after it.
 * Pure, for tests.
 */
export function bucketOf(block: bigint, baseTs: number, located: ReadonlyArray<readonly [number, bigint]>, tf: Timeframe, nowMs: number): number | null {
  const step = TIMEFRAME_MS[tf] / 1000;
  let t = Math.floor(baseTs / step) * step;
  let lo = 0;
  let hi = located.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (located[mid]![1] <= block) {
      t = located[mid]![0];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const ms = t * 1000;
  return ms < windowStart(nowMs, tf) ? null : ms;
}

/** A swap's price as a wad rounded down to 4 decimals, or null when out of (0, 1e9) USDG. */
export function swapPriceWad(sqrtPriceX96: bigint, stockIsToken0: boolean, stockDecimals: number, usdgDecimals: number): Wad | null {
  const w = sqrtPriceToWad(sqrtPriceX96, stockIsToken0, stockDecimals, usdgDecimals);
  if (w === null) return null;
  const r = roundTo(w, 4, 'floor');
  return r > 0n && r < MAX_PRICE_WAD ? r : null;
}

/** Median of a non-empty list of wads (the lower middle for an even count). */
export function medianWad(list: readonly Wad[]): Wad {
  const s = [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[(s.length - 1) >> 1]!;
}

/** One bucket's aggregate of a processed range. */
interface Agg {
  marketId: string;
  key: string;
  tf: Timeframe;
  c: WadCandle;
}

export interface DexCandlesOptions {
  client: DexClient;
  cfg: UniswapConfig;
  chainId: number;
  now?: () => number;
}

/** The DEX candle builder. One instance per workers process, driven by `step` (one job at a time). */
export class DexCandles {
  readonly liveKey: string;
  readonly historyKey: string;
  private readonly pools: UniPool[];
  private readonly clock: BlockClock;
  private readonly now: () => number;
  private cursor: BlockHeader | null = null;
  /** The lowest block not yet in history (history covers (history, live]); null once history is complete. */
  private history: bigint | null = null;
  /** Below this block, history is not needed (before the oldest timeframe window). */
  private historyFloor = 0n;
  private guard = jumpGuard();
  private last = new Map<string, string>();

  constructor(private readonly o: DexCandlesOptions) {
    this.pools = [...chartPools(o.cfg).values()].flat();
    const fp = poolsFingerprint(this.pools);
    this.liveKey = DEX_LIVE_PREFIX + fp;
    this.historyKey = DEX_HISTORY_PREFIX + fp;
    this.now = o.now ?? Date.now;
    this.clock = new BlockClock(async (n) => {
      const b = await o.client.getBlock({ blockNumber: n, includeTransactions: false });
      if (b.number === null || b.hash === null) throw new Error(`block ${n} is pending`);
      return { number: b.number, timestamp: Number(b.timestamp), hash: b.hash };
    });
  }

  /** Header reads so far (logs, tests). */
  get headerReads(): number {
    return this.clock.reads;
  }

  /** The live cursor (last processed block), once started. */
  get checkpoint(): bigint | null {
    return this.cursor?.number ?? null;
  }

  /** The lowest block not yet in history, or null once history is complete (or before start). */
  get historyCursor(): bigint | null {
    return this.history;
  }

  /** True once history reaches back past every timeframe's window. */
  get historyDone(): boolean {
    return this.cursor !== null && this.history === null;
  }

  private where(key: string) {
    return { chainId_deployment: { chainId: this.o.chainId, deployment: key } };
  }

  /** Loads both cursors, or rebuilds (see the file comment). */
  private async start(ctx: WorkerContext): Promise<void> {
    const [cp, hp] = await Promise.all([ctx.prisma.indexerCheckpoint.findUnique({ where: this.where(this.liveKey) }), ctx.prisma.indexerCheckpoint.findUnique({ where: this.where(this.historyKey) })]);
    const head = (await this.o.client.getBlockNumber()) - DEX_CONFIRMATIONS;
    await this.findHistoryFloor(head);
    if (cp && hp) {
      const h = await this.clock.header(cp.block);
      if (h.hash.toLowerCase() === cp.blockHash.toLowerCase()) {
        this.cursor = h;
        this.history = hp.block > this.historyFloor ? hp.block : null;
        this.seedLast(ctx);
        ctx.log.info('dex candles: resuming', { live: h.number.toString(), history: this.history?.toString() ?? 'complete' });
        return;
      }
      ctx.log.warn('dex candles: the live checkpoint block is no longer on the chain; rebuilding', { block: cp.block.toString() });
    }
    const top = await this.clock.header(head);
    await ctx.prisma.$transaction([
      ctx.prisma.candle.deleteMany({ where: { source: DEX_SOURCE } }),
      ctx.prisma.indexerCheckpoint.deleteMany({ where: { chainId: this.o.chainId, deployment: { startsWith: DEX_KEY_PREFIX } } }),
      ctx.prisma.indexerCheckpoint.create({ data: { chainId: this.o.chainId, deployment: this.liveKey, block: top.number, blockHash: top.hash } }),
      ctx.prisma.indexerCheckpoint.create({ data: { chainId: this.o.chainId, deployment: this.historyKey, block: top.number, blockHash: '' } }),
    ]);
    for (const symbol of ctx.marketIds.keys()) for (const tf of TIMEFRAMES) ctx.series.set(seriesKey(symbol, tf), []);
    await writeCandleCaches(ctx.redis, ctx.mac, DEX_SOURCE, ctx.series);
    this.last.clear();
    this.guard = jumpGuard();
    this.cursor = top;
    this.history = top.number > this.historyFloor ? top.number : null;
    ctx.log.info('dex candles: building history from the chain, newest first', { head: top.number.toString(), floor: this.historyFloor.toString() });
  }

  /** The first block at or after the oldest timeframe window (0 when the chain is younger than that). */
  private async findHistoryFloor(head: bigint): Promise<void> {
    const oldest = Math.ceil(oldestWindowStart(this.now()) / 1000);
    const genesis = await this.clock.header(0n);
    if (genesis.timestamp >= oldest) {
      this.historyFloor = 0n;
      return;
    }
    const top = await this.clock.header(head);
    this.historyFloor = top.timestamp < oldest ? head : await this.clock.firstAtOrAfter(oldest, genesis, top);
  }

  /** The live guard's reference after a restart: the newest close in memory per market. */
  private seedLast(ctx: WorkerContext): void {
    for (const symbol of ctx.marketIds.keys()) {
      let best: WadCandle | undefined;
      for (const tf of TIMEFRAMES) {
        const c = ctx.series.get(seriesKey(symbol, tf))?.at(-1);
        if (c && (!best || c.t >= best.t)) best = c;
      }
      if (best) this.last.set(symbol, toDecimalString(best.c));
    }
  }

  /**
   * One job: the live cursor catches up with the head (DEX_CONFIRMATIONS behind) in ranges of at most DEX_CHUNK
   * blocks, then history walks back with what is left of `budgetMs`. Returns the number of swaps folded in.
   */
  async step(ctx: WorkerContext, budgetMs = DEX_STEP_BUDGET_MS): Promise<number> {
    try {
      if (!this.cursor) await this.start(ctx);
      const deadline = Date.now() + budgetMs;
      const head = (await this.o.client.getBlockNumber()) - DEX_CONFIRMATIONS;
      let folded = 0;
      while (this.cursor!.number < head) {
        const to = head - this.cursor!.number > DEX_CHUNK ? this.cursor!.number + DEX_CHUNK : head;
        folded += await this.forward(ctx, to);
        if (Date.now() > deadline) break;
      }
      while (this.history !== null && Date.now() < deadline) folded += await this.backward(ctx);
      await ctx.redis.set(cacheKeys.heartbeat(CANDLES_WORKER), ctx.mac.seal(cacheKeys.heartbeat(CANDLES_WORKER), String(Date.now())));
      return folded;
    } catch (err) {
      if (err instanceof CheckpointMoved) {
        // Start over from what Postgres holds.
        this.cursor = null;
        this.history = null;
        this.guard = jumpGuard();
      }
      throw err;
    }
  }

  /**
   * Locates every boundary that matters between `base` and `top` (base.timestamp < T <= top.timestamp) and returns,
   * per timeframe, the boundaries with their first blocks.
   */
  private async locate(base: BlockHeader, top: BlockHeader, nowMs: number): Promise<Record<Timeframe, Array<readonly [number, bigint]>>> {
    const perTf = boundariesIn(base.timestamp, top.timestamp, nowMs);
    const unique = [...new Set(TIMEFRAMES.flatMap((tf) => perTf[tf]))].sort((a, b) => a - b);
    const at = new Map<number, bigint>();
    for (let i = 0; i < unique.length; i += BOUNDARY_GROUP) {
      const group = unique.slice(i, i + BOUNDARY_GROUP);
      const blocks = await Promise.all(group.map((t) => this.clock.firstAtOrAfter(t, base, top)));
      group.forEach((t, j) => at.set(t, blocks[j]!));
    }
    return Object.fromEntries(TIMEFRAMES.map((tf) => [tf, perTf[tf].map((t) => [t, at.get(t)!] as const)])) as Record<Timeframe, Array<readonly [number, bigint]>>;
  }

  /**
   * Aggregates accepted swaps into one candle per (market, timeframe, bucket), oldest first within each bucket.
   * `accept` decides per swap (the jump guard).
   */
  private aggregate(ctx: WorkerContext, swaps: DexSwap[], prices: Array<Wad | null>, base: BlockHeader, located: Record<Timeframe, Array<readonly [number, bigint]>>, nowMs: number, accept: (s: DexSwap, w: Wad) => boolean): Map<string, Agg> {
    const aggs = new Map<string, Agg>();
    swaps.forEach((s, i) => {
      const w = prices[i];
      const marketId = ctx.marketIds.get(s.symbol);
      if (w === null || w === undefined || !marketId || !accept(s, w)) return;
      for (const tf of TIMEFRAMES) {
        const t = bucketOf(s.block, base.timestamp, located[tf], tf, nowMs);
        if (t === null) continue;
        const key = seriesKey(s.symbol, tf);
        const id = `${key}:${t}`;
        const a = aggs.get(id);
        if (!a) aggs.set(id, { marketId, key, tf, c: { t, o: w, h: w, l: w, c: w } });
        else a.c = { t, o: a.c.o, h: wmax(a.c.h, w), l: wmin(a.c.l, w), c: w };
      }
    });
    return aggs;
  }

  private priceOf = (s: DexSwap): Wad | null => {
    const d = this.o.cfg.decimals[s.symbol];
    return d === undefined ? null : swapPriceWad(s.sqrtPriceX96, s.stockIsToken0, d, this.o.cfg.usdg.decimals);
  };

  /** Writes aggregates and moves a checkpoint in one transaction (only if the checkpoint is where this process left it). */
  private async commit(ctx: WorkerContext, aggs: Map<string, Agg>, mode: 'append' | 'prepend', move: { key: string; from: bigint; fromHash?: string; to: bigint; toHash: string }): Promise<void> {
    const rows: CandleRow[] = [...aggs.values()].map((a) => ({ marketId: a.marketId, tf: a.tf, ...toCandle(a.c) }));
    await ctx.prisma.$transaction(
      async (tx) => {
        const moved = await tx.indexerCheckpoint.updateMany({
          where: { chainId: this.o.chainId, deployment: move.key, block: move.from, ...(move.fromHash !== undefined ? { blockHash: move.fromHash } : {}) },
          data: { block: move.to, blockHash: move.toHash },
        });
        if (moved.count !== 1) throw new CheckpointMoved();
        for (let i = 0; i < rows.length; i += CANDLE_MERGE_BATCH) await tx.$executeRaw(candleMergeSql(rows.slice(i, i + CANDLE_MERGE_BATCH), DEX_SOURCE, mode));
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  }

  /** After a commit: the same merge in memory (ctx.series), then the Redis cache of the touched series. */
  private async remember(ctx: WorkerContext, aggs: Map<string, Agg>, mode: 'append' | 'prepend'): Promise<void> {
    const touched = new Set<string>();
    for (const a of aggs.values()) {
      const s = ctx.series.get(a.key) ?? [];
      mergeCandle(s, a.c, mode, CANDLE_CACHE_SIZE);
      ctx.series.set(a.key, s);
      touched.add(a.key);
    }
    if (touched.size) await writeCandleCaches(ctx.redis, ctx.mac, DEX_SOURCE, ctx.series, touched);
  }

  /** The live cursor: blocks (cursor, to], newer than anything stored. */
  private async forward(ctx: WorkerContext, to: bigint): Promise<number> {
    const lo = this.cursor!;
    const hi = await this.clock.header(to);
    if (hi.timestamp < lo.timestamp) throw new Error(`block ${to} is dated before block ${lo.number}`);
    const nowMs = this.now();
    const swaps = await getSwapLogs(this.o.client, this.o.cfg, this.pools, lo.number + 1n, to);
    let folded = 0;
    let aggs = new Map<string, Agg>();
    if (swaps.length) {
      const located = await this.locate(lo, hi, nowMs);
      const prices = swaps.map(this.priceOf);
      aggs = this.aggregate(ctx, swaps, prices, lo, located, nowMs, (s, w) => {
        const price = toDecimalString(w);
        if (!this.guard(s.symbol, price, this.last.get(s.symbol))) {
          ctx.log.warn('dex candles: swap price held, large jump awaiting confirmation', { symbol: s.symbol, price, last: this.last.get(s.symbol), block: s.block.toString() });
          return false;
        }
        this.last.set(s.symbol, price);
        folded++;
        return true;
      });
    }
    await this.commit(ctx, aggs, 'append', { key: this.liveKey, from: lo.number, fromHash: lo.hash, to: hi.number, toHash: hi.hash });
    await this.remember(ctx, aggs, 'append');
    this.cursor = hi;
    return folded;
  }

  /** The history cursor: one range of blocks just below what is stored, older than anything stored. */
  private async backward(ctx: WorkerContext): Promise<number> {
    const b = this.history!;
    const a = b - DEX_CHUNK + 1n > this.historyFloor ? b - DEX_CHUNK + 1n : this.historyFloor > 0n ? this.historyFloor : 1n;
    const nowMs = this.now();
    const swaps = await getSwapLogs(this.o.client, this.o.cfg, this.pools, a, b);
    let folded = 0;
    let aggs = new Map<string, Agg>();
    if (swaps.length) {
      // Boundaries only matter between the first and the last swap of the range.
      const first = await this.clock.header(swaps[0]!.block);
      const lastH = await this.clock.header(swaps[swaps.length - 1]!.block);
      const located = first.number < lastH.number && first.timestamp < lastH.timestamp ? await this.locate(first, lastH, nowMs) : (Object.fromEntries(TIMEFRAMES.map((tf) => [tf, []])) as unknown as Record<Timeframe, Array<readonly [number, bigint]>>);
      const prices = swaps.map(this.priceOf);
      // The guard's reference: each market's median price in this range (history has no "last accepted" before it).
      const bySymbol = new Map<string, Wad[]>();
      swaps.forEach((s, i) => {
        const w = prices[i];
        if (w !== null && w !== undefined) bySymbol.set(s.symbol, [...(bySymbol.get(s.symbol) ?? []), w]);
      });
      const ref = new Map([...bySymbol].map(([k, v]) => [k, toDecimalString(medianWad(v))]));
      const guard = jumpGuard();
      aggs = this.aggregate(ctx, swaps, prices, first, located, nowMs, (s, w) => {
        const price = toDecimalString(w);
        if (!guard(s.symbol, price, ref.get(s.symbol))) return false;
        ref.set(s.symbol, price);
        folded++;
        return true;
      });
    }
    const next = a - 1n;
    await this.commit(ctx, aggs, 'prepend', { key: this.historyKey, from: b, to: next, toHash: '' });
    await this.remember(ctx, aggs, 'prepend');
    this.history = next > this.historyFloor && next > 0n ? next : null;
    if (this.history === null) ctx.log.info('dex candles: history complete', { live: this.cursor!.number.toString(), headerReads: this.clock.reads });
    return folded;
  }
}
