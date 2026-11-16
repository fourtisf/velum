/**
 * On-chain DEX trades of the configured Stock Token / USDG pools, for display only (packages/config/src/dex.ts).
 * Kept apart from src/onchain (the gated Phase 3 indexer) and from every price source: nothing here writes a price
 * snapshot, a quote candle or anything the relayer, the oracle or a trade reads. It reads the official snapshot
 * only to bound DEX trades against the last quote.
 *
 * Each run: confirmed blocks only (the `safe` head: posted to the parent chain), chunked eth_getLogs over the
 * selected pools' Swap events, every swap decoded with exact decimals and classified by the guards (dust, quote
 * bound, rolling median), stored in DexTrade, the touched buckets of DexCandle rebuilt from the stored trades,
 * the checkpoint moved. A checkpoint whose block hash changed (a reorg) rewinds and rebuilds. Pool liquidity is
 * read every few minutes; a pool under the thresholds is flagged and the API stops showing it.
 */
import { createHash } from 'node:crypto';
import {
  DEX_CACHE_KEY,
  DEX_PARAMS,
  DEX_SWAP_TOPIC,
  DEX_TIMEFRAMES,
  TIMEFRAME_MS,
  classifyDexTrade,
  decToWad,
  dexLiquidityOk,
  dexToken,
  dexTradePrice,
  lastEndedSession,
  wadToDec,
  type DexPool,
  type DexSnapshot,
  type DexTradeStatus,
} from '@velum/config';
import type { CacheMac } from '@velum/config/src/cache-mac';
import { Prisma, type PrismaClient } from '@velum/db';
import type { Redis } from 'ioredis';
import type { Logger } from '../lib/log';
import type { DexBlock, DexLog, DexRpc } from './rpc';

const WAD = 10n ** 18n;
const BALANCE_OF = '0x70a08231';
const TOKEN0 = '0x0dfe1681';
const TOKEN1 = '0xd21220a7';

export interface DexSettings {
  /** Blocks indexed back from the confirmed head on the first run (default: 96 hours at 0.108 s per block). */
  backfillBlocks: bigint;
  /** Blocks per eth_getLogs (the public RPC allows 100,000 with an address list and 10,000 logs per answer). */
  chunkBlocks: bigint;
  /** At most this many chunks per run: a long backfill spreads over several runs. */
  maxChunksPerRun: number;
  /** Depth below latest used when the RPC has no `safe` tag. */
  fallbackDepth: bigint;
  /** How far a detected reorg rewinds. */
  rewindBlocks: bigint;
  /** How often pool liquidity is read. */
  liquidityEveryMs: number;
  /** DexTrade rows older than this are pruned (candles are kept). */
  retentionMs: number;
}

export const DEFAULT_DEX_SETTINGS: DexSettings = {
  backfillBlocks: 3_200_000n,
  chunkBlocks: 5_000n,
  maxChunksPerRun: 40,
  fallbackDepth: 3_000n,
  rewindBlocks: 2_000n,
  liquidityEveryMs: 5 * 60_000,
  retentionMs: 7 * 86_400_000,
};

export interface DexContext {
  prisma: PrismaClient;
  redis: Redis;
  mac: CacheMac;
  log: Logger;
  rpc: DexRpc;
  chainId: number;
  /** Pools whose token0/token1 were checked (verifyPools). */
  pools: DexPool[];
  /** The last official quote of a market (token basis, decimal string), or null: only to bound DEX trades. */
  quote(symbol: string): string | null;
  settings: DexSettings;
  /** Liquidity per pool, refreshed every settings.liquidityEveryMs. */
  liquidity: Map<string, { usdgSide: bigint; tokenSideUsdg: bigint; at: number }>;
  lastPruneAt?: number;
  now?: () => number;
}

/** Checkpoint key: a different pool set (a pool replaced in config) starts a fresh index. */
export function checkpointKey(chainId: number, pools: readonly DexPool[]): string {
  const set = pools.map((p) => p.pool).sort().join(',');
  return `dex:${chainId}:${createHash('sha256').update(set).digest('hex').slice(0, 16)}`;
}

const word = (data: string, i: number): bigint => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64));
const pad = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const addrOf = (ret: string): string => '0x' + ret.slice(-40).toLowerCase();
/** CAST so the session time zone never shifts a time (timestamp(3) columns hold UTC, as everywhere in Velum). */
const ts = (t: number) => Prisma.sql`CAST(${new Date(t).toISOString().slice(0, -1)} AS TIMESTAMP(3))`;

/**
 * Checks each configured pool against the chain: token0/token1 must be USDG and the market's Stock Token in the
 * configured order. A pool that does not match (a config error, or a different contract) is left out and logged.
 */
export async function verifyPools(rpc: DexRpc, pools: readonly DexPool[], log: Logger): Promise<DexPool[]> {
  const usdg = dexToken('USDG')?.address;
  const ok: DexPool[] = [];
  for (const p of pools) {
    const stock = dexToken(p.symbol)?.address;
    try {
      const [t0, t1] = [addrOf(await rpc.call(p.pool, TOKEN0)), addrOf(await rpc.call(p.pool, TOKEN1))];
      const want = p.usdgIsToken0 ? [usdg, stock] : [stock, usdg];
      if (t0 === want[0] && t1 === want[1]) ok.push(p);
      else log.error('DEX pool left out: its tokens do not match the configuration', { symbol: p.symbol, pool: p.pool });
    } catch (err) {
      log.warn('DEX pool not checked (RPC); left out until the next start', { symbol: p.symbol, pool: p.pool, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return ok;
}

export interface DecodedTrade {
  pool: string;
  symbol: string;
  txHash: string;
  logIndex: number;
  block: bigint;
  at: number;
  price: bigint;
  qty: bigint;
  notional: bigint;
}

/** One Swap log of a known pool as a trade (exact decimals), or null when it carries no readable price. */
export function decodeSwap(log: DexLog, pool: DexPool, at: number): DecodedTrade | null {
  if (log.removed || log.topics[0]?.toLowerCase() !== DEX_SWAP_TOPIC || log.data.length < 2 + 64 * 5) return null;
  const amount0 = BigInt.asIntN(256, word(log.data, 0));
  const amount1 = BigInt.asIntN(256, word(log.data, 1));
  const stock = dexToken(pool.symbol);
  const usdg = dexToken('USDG');
  if (!stock || !usdg) return null;
  const p = dexTradePrice(amount0, amount1, pool.usdgIsToken0, stock.decimals, usdg.decimals);
  if (!p) return null;
  return { pool: pool.pool, symbol: pool.symbol, txHash: log.transactionHash, logIndex: log.logIndex, block: log.blockNumber, at, price: p.price, qty: p.qty, notional: p.notional };
}

/** Block time of `n` (ms), linear between two headers of the same chunk (measured error: seconds over 20,000 blocks). */
export const interpolateAt = (n: bigint, a: DexBlock, b: DexBlock): number => {
  if (b.number <= a.number) return a.timestamp * 1000;
  return Math.round(a.timestamp * 1000 + (Number(n - a.number) * (b.timestamp - a.timestamp) * 1000) / Number(b.number - a.number));
};

/** DexCandle rows for [from, to) rebuilt from the ok trades of `pools` (delete, then insert): idempotent. */
export function dexCandleSql(pools: readonly string[], from: number, to: number): Prisma.Sql[] {
  const list = Prisma.join(pools.map((p) => p.toLowerCase()));
  return DEX_TIMEFRAMES.flatMap((tf) => {
    const secs = TIMEFRAME_MS[tf] / 1000;
    return [
      Prisma.sql`DELETE FROM "DexCandle" WHERE "tf" = ${tf} AND "pool" IN (${list}) AND "t" >= ${ts(from)} AND "t" < ${ts(to)}`,
      Prisma.sql`
        INSERT INTO "DexCandle" ("symbol", "tf", "t", "o", "h", "l", "c", "trades", "pool")
        SELECT d."symbol", ${tf},
               TIMESTAMP '1970-01-01' + floor(extract(epoch FROM d."at") / ${secs}) * ${secs} * interval '1 second',
               (array_agg(d."price" ORDER BY d."block", d."logIndex"))[1],
               max(d."price"), min(d."price"),
               (array_agg(d."price" ORDER BY d."block" DESC, d."logIndex" DESC))[1],
               count(*)::int, min(d."pool")
        FROM "DexTrade" d
        WHERE d."status" = 'ok' AND d."pool" IN (${list}) AND d."at" >= ${ts(from)} AND d."at" < ${ts(to)}
        GROUP BY d."symbol", 3
        ON CONFLICT ("symbol", "tf", "t") DO UPDATE SET
          "o" = EXCLUDED."o", "h" = EXCLUDED."h", "l" = EXCLUDED."l", "c" = EXCLUDED."c", "trades" = EXCLUDED."trades", "pool" = EXCLUDED."pool"`,
    ];
  });
}

const FOUR_H = TIMEFRAME_MS['4h'];
/** [from, to) widened to whole 4-hour buckets (which hold whole 15m and 1h buckets). */
const widen = (from: number, to: number): [number, number] => [Math.floor(from / FOUR_H) * FOUR_H, Math.ceil((to + 1) / FOUR_H) * FOUR_H];

async function rebuildCandles(ctx: DexContext, from: number, to: number): Promise<void> {
  const [a, b] = widen(from, to);
  await ctx.prisma.$transaction(dexCandleSql(ctx.pools.map((p) => p.pool), a, b).map((q) => ctx.prisma.$executeRaw(q)));
}

/** The previous non-dust trades within the quote bound of each pool, oldest first: the median windows. */
async function loadWindows(ctx: DexContext): Promise<Map<string, bigint[]>> {
  const out = new Map<string, bigint[]>();
  for (const p of ctx.pools) {
    const rows = await ctx.prisma.dexTrade.findMany({
      where: { pool: p.pool, status: { in: ['ok', 'median'] } },
      orderBy: [{ block: 'desc' }, { logIndex: 'desc' }],
      take: DEX_PARAMS.medianWindow - 1,
      select: { price: true },
    });
    out.set(p.pool, rows.reverse().map((r) => decToWad(r.price.toFixed()) ?? 0n));
  }
  return out;
}

export interface DexRunResult {
  trades: number;
  from: bigint | null;
  to: bigint | null;
  reorg: boolean;
}

/** One indexer run (see the module comment). Throws on an RPC failure after saving what was done. */
export async function runDex(ctx: DexContext): Promise<DexRunResult> {
  const now = ctx.now?.() ?? Date.now();
  const result: DexRunResult = { trades: 0, from: null, to: null, reorg: false };
  if (!ctx.pools.length) return result;
  const key = checkpointKey(ctx.chainId, ctx.pools);
  const byPool = new Map<string, DexPool>(ctx.pools.map((p) => [p.pool, p]));
  const head = await ctx.rpc.confirmedHead(ctx.settings.fallbackDepth);
  const cp = await ctx.prisma.dexCheckpoint.findUnique({ where: { key } });

  if (cp) {
    const seen = await ctx.rpc.block(cp.block);
    if (seen.hash.toLowerCase() !== cp.blockHash.toLowerCase()) {
      // Reorg below the checkpoint (never expected on confirmed blocks): drop the trades of the rewound range,
      // rebuild their buckets, and index again from there.
      const back = cp.block > ctx.settings.rewindBlocks ? cp.block - ctx.settings.rewindBlocks : 0n;
      const gone = await ctx.prisma.dexTrade.findFirst({ where: { pool: { in: [...byPool.keys()] }, block: { gt: back } }, orderBy: { at: 'asc' }, select: { at: true } });
      await ctx.prisma.dexTrade.deleteMany({ where: { pool: { in: [...byPool.keys()] }, block: { gt: back } } });
      if (gone) await rebuildCandles(ctx, gone.at.getTime(), now);
      const anchor = await ctx.rpc.block(back);
      await ctx.prisma.dexCheckpoint.update({ where: { key }, data: { block: back, blockHash: anchor.hash } });
      ctx.log.warn('DEX indexer rewound after a block hash changed below its checkpoint', { from: cp.block.toString(), to: back.toString() });
      return { ...result, reorg: true };
    }
  }

  let from = cp ? cp.block + 1n : head.number > ctx.settings.backfillBlocks ? head.number - ctx.settings.backfillBlocks : 0n;
  result.from = from;
  const windows = await loadWindows(ctx);
  for (let i = 0; i < ctx.settings.maxChunksPerRun && from <= head.number; i++) {
    const to = from + ctx.settings.chunkBlocks - 1n < head.number ? from + ctx.settings.chunkBlocks - 1n : head.number;
    const logs = await ctx.rpc.logs([...byPool.keys()], DEX_SWAP_TOPIC, from, to);
    const last = i === ctx.settings.maxChunksPerRun - 1 || to === head.number;
    const end = to === head.number ? head : logs.length || last ? await ctx.rpc.block(to) : null;
    if (logs.length && end) {
      const start = await ctx.rpc.block(from);
      const rows: Prisma.DexTradeCreateManyInput[] = [];
      let lo = Infinity;
      let hi = -Infinity;
      for (const l of [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))) {
        const pool = byPool.get(l.address.toLowerCase());
        if (!pool) continue;
        const t = decodeSwap(l, pool, interpolateAt(l.blockNumber, start, end));
        if (!t) continue;
        const q = ctx.quote(pool.symbol);
        const w = windows.get(pool.pool) ?? [];
        const status: DexTradeStatus = classifyDexTrade(t, q ? decToWad(q) : null, w);
        if (status === 'ok' || status === 'median') {
          w.push(t.price);
          if (w.length > DEX_PARAMS.medianWindow - 1) w.shift();
          windows.set(pool.pool, w);
        }
        rows.push({ pool: t.pool, txHash: t.txHash, logIndex: t.logIndex, block: t.block, at: new Date(t.at), symbol: t.symbol, price: wadToDec(t.price), qty: wadToDec(t.qty), notional: wadToDec(t.notional), status });
        lo = Math.min(lo, t.at);
        hi = Math.max(hi, t.at);
      }
      if (rows.length) {
        await ctx.prisma.dexTrade.createMany({ data: rows, skipDuplicates: true });
        await rebuildCandles(ctx, lo, hi);
        result.trades += rows.length;
      }
    }
    if (end) await ctx.prisma.dexCheckpoint.upsert({ where: { key }, create: { key, block: to, blockHash: end.hash }, update: { block: to, blockHash: end.hash } });
    result.to = to;
    from = to + 1n;
  }

  await refreshLiquidity(ctx, now);
  await publishSnapshots(ctx, now);
  if (ctx.lastPruneAt === undefined || now - ctx.lastPruneAt > 3_600_000) {
    ctx.lastPruneAt = now;
    await ctx.prisma.dexTrade.deleteMany({ where: { at: { lt: new Date(now - ctx.settings.retentionMs) } } });
  }
  return result;
}

async function lastOk(ctx: DexContext, pool: string) {
  return ctx.prisma.dexTrade.findFirst({ where: { pool, status: 'ok' }, orderBy: [{ block: 'desc' }, { logIndex: 'desc' }], select: { price: true, at: true, block: true } });
}

/** Balances held by each pool (USDG, and tokens valued at the last ok trade, else the official quote). */
export async function refreshLiquidity(ctx: DexContext, now: number): Promise<void> {
  const usdg = dexToken('USDG');
  if (!usdg) return;
  for (const p of ctx.pools) {
    const prev = ctx.liquidity.get(p.pool);
    if (prev && now - prev.at < ctx.settings.liquidityEveryMs) continue;
    const stock = dexToken(p.symbol);
    if (!stock) continue;
    try {
      const u = BigInt(await ctx.rpc.call(usdg.address, BALANCE_OF + pad(p.pool)));
      const s = BigInt(await ctx.rpc.call(stock.address, BALANCE_OF + pad(p.pool)));
      const ref = (await lastOk(ctx, p.pool))?.price.toFixed() ?? ctx.quote(p.symbol);
      const px = ref ? (decToWad(ref) ?? 0n) : 0n;
      const usdgSide = u * 10n ** BigInt(18 - usdg.decimals);
      const tokens = s * 10n ** BigInt(18 - stock.decimals);
      ctx.liquidity.set(p.pool, { usdgSide, tokenSideUsdg: (tokens * px) / WAD, at: now });
    } catch (err) {
      ctx.log.warn('DEX pool liquidity not read; the pool keeps its last reading', { symbol: p.symbol, err: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Publishes each pool's last ok trade and liquidity to Redis (authenticated), for the API. */
export async function publishSnapshots(ctx: DexContext, now: number): Promise<void> {
  const pipe = ctx.redis.pipeline();
  for (const p of ctx.pools) {
    const t = await lastOk(ctx, p.pool);
    const liq = ctx.liquidity.get(p.pool);
    if (!t || !liq) continue;
    // The pool's own price at the last session's close: its last ok trade before 20:00 ET (within a day).
    const end = lastEndedSession(now).end;
    const atClose = await ctx.prisma.dexTrade.findFirst({
      // (symbol, at) index, newest first: one short backward scan from the close.
      where: { symbol: p.symbol, pool: p.pool, status: 'ok', at: { lte: new Date(end), gte: new Date(end - DEX_PARAMS.closeWindowMs) } },
      orderBy: [{ at: 'desc' }, { block: 'desc' }, { logIndex: 'desc' }],
      select: { price: true, at: true },
    });
    const snap: DexSnapshot = {
      symbol: p.symbol,
      pool: p.pool,
      price: t.price.toFixed(),
      tradeAt: t.at.getTime(),
      block: Number(t.block),
      liquidityUsdg: wadToDec(liq.usdgSide + liq.tokenSideUsdg),
      usdgSide: wadToDec(liq.usdgSide),
      tokenSideUsdg: wadToDec(liq.tokenSideUsdg),
      belowThreshold: !dexLiquidityOk(liq.usdgSide, liq.tokenSideUsdg),
      liquidityAt: liq.at,
      checkedAt: now,
      close: atClose ? { end, price: atClose.price.toFixed(), at: atClose.at.getTime() } : null,
    };
    if (snap.belowThreshold) ctx.log.warn('DEX pool under the liquidity threshold: not shown', { symbol: p.symbol, pool: p.pool, liquidityUsdg: snap.liquidityUsdg });
    const k = DEX_CACHE_KEY(p.symbol);
    pipe.set(k, ctx.mac.seal(k, JSON.stringify(snap)));
  }
  await pipe.exec();
}
