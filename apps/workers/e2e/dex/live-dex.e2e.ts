/**
 * Live check of the DEX candles (PRICE_SOURCE=uniswap) against Robinhood Chain mainnet, read-only:
 *   1. builds the candle history from the chain into a scratch database (DexCandles, exactly as the workers run it:
 *      newest first, then live steps; resuming from its checkpoints when the database already has them), timing it,
 *      until history covers the last 4 days (DEX_E2E_FULL=1: all of it);
 *   2. re-derives the last ~3 hours independently: every swap of the chart pools with its own block's timestamp (one
 *      header read per swap block, the slow exact way), aggregated into 15m and 1h buckets, and compares every bucket
 *      that lies fully inside that window with the stored candle (open, high, low, close, exactly);
 *   3. reads the price source once and checks it against the newest candles.
 *
 * Run (scratch database migrated with `prisma migrate deploy`, a Redis it may write to):
 *   VELUM_NETWORK=mainnet DEX_DATABASE_URL=postgresql://… DEX_REDIS_URL=redis://… pnpm --filter @velum/workers exec tsx e2e/dex/live-dex.e2e.ts
 * Optional: RPC_URL (default: the official mainnet RPC). Every uniswap candle in the scratch database is replaced.
 */
import { CHAIN, MARKETS, TIMEFRAMES, TIMEFRAME_MS, type Timeframe } from '@velum/config';
import { createCacheMac } from '@velum/config/src/cache-mac';
import { UNISWAP } from '@velum/config/src/uniswap';
import { PrismaClient } from '@velum/db';
import { Redis } from 'ioredis';
import { loadSeries, upsertMarkets } from '../../src/bootstrap';
import type { WorkerContext } from '../../src/context';
import { DexCandles, swapPriceWad, windowStart } from '../../src/jobs/dex-candles';
import { applyTick, bucketStart, toCandle, type WadCandle } from '../../src/lib/candles';
import type { Logger } from '../../src/lib/log';
import { chartPools, getSwapLogs, uniswapClient, uniswapSource } from '../../src/sources/uniswap';

const DB = process.env.DEX_DATABASE_URL;
const REDIS = process.env.DEX_REDIS_URL;
const RPC = process.env.RPC_URL || CHAIN.rpcUrl;
if (!DB || !REDIS) throw new Error('Set DEX_DATABASE_URL and DEX_REDIS_URL (scratch instances).');
if (!UNISWAP || CHAIN.id !== 4663) throw new Error('Run with VELUM_NETWORK=mainnet.');

const t0 = Date.now();
const say = (...a: unknown[]) => console.log(`[dex +${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const log: Logger = {
  debug() {},
  info: (m, f) => say(m, f ?? ''),
  warn: (m, f) => say('WARN', m, f ?? ''),
  error: (m, f) => say('ERROR', m, f ?? ''),
};

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: DB } } });
  const u = new URL(REDIS!);
  const redis = new Redis({ host: u.hostname, port: Number(u.port || 6379), password: decodeURIComponent(u.password) || undefined, maxRetriesPerRequest: null });
  const mac = createCacheMac(DB!, 'mainnet');
  const marketIds = await upsertMarkets(prisma);
  const client = uniswapClient(RPC);
  const ctx = {
    env: {} as WorkerContext['env'],
    prisma,
    redis,
    log,
    source: { name: 'uniswap', read: async () => new Map() },
    marketIds,
    snapshots: new Map(),
    open24h: new Map(),
    lastOpenRefresh: 0,
    series: await loadSeries(prisma, marketIds, 'uniswap'),
    lastTickAt: new Map(),
    mac,
    enqueueCandles: async () => undefined,
  } as WorkerContext;

  const dex = new DexCandles({ client, cfg: UNISWAP!, chainId: CHAIN.id });
  let swaps = 0;
  let firstStep = 0;
  let lastLog = 0;
  // By default the check needs the last few days only (the re-derivation below covers the last ~3 hours); with
  // DEX_E2E_FULL=1 it waits for the whole history (about an hour or more on the public RPC).
  const full = process.env.DEX_E2E_FULL === '1';
  const enough = async () => {
    if (dex.historyDone) return true;
    if (full || dex.historyCursor === null) return false;
    const h = await client.getBlock({ blockNumber: dex.historyCursor });
    return Number(h.timestamp) * 1000 < Date.now() - 4 * 86_400_000;
  };
  while (dex.checkpoint === null || !(await enough())) {
    swaps += await dex.step(ctx);
    if (!firstStep) firstStep = Date.now() - t0;
    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now();
      say('progress', { swaps, headerReads: dex.headerReads, live: dex.checkpoint?.toString() });
    }
  }
  const built = Date.now() - t0;
  say('history built', { ms: built, firstStepMs: firstStep, swaps, headerReads: dex.headerReads, checkpoint: dex.checkpoint?.toString() });

  // Independent re-derivation of the last ~3 hours with one exact header read per swap block.
  const head = dex.checkpoint!;
  const from = head - 89_999n;
  const pools = [...chartPools(UNISWAP!).values()].flat();
  const recent = await getSwapLogs(client, UNISWAP!, pools, from, head);
  const fromTs = Number((await client.getBlock({ blockNumber: from - 1n })).timestamp);
  const headTs = Number((await client.getBlock({ blockNumber: head })).timestamp);
  const tsOf = new Map<bigint, number>();
  const blocks = [...new Set(recent.map((s) => s.block))];
  for (let i = 0; i < blocks.length; i += 50) {
    const group = blocks.slice(i, i + 50);
    const hs = await Promise.all(group.map((b) => client.getBlock({ blockNumber: b })));
    hs.forEach((h, j) => tsOf.set(group[j]!, Number(h.timestamp)));
  }
  say('re-derivation window', { blocks: `${from}..${head}`, swaps: recent.length, swapBlocks: blocks.length });
  const problems: string[] = [];
  let compared = 0;
  const now = Date.now();
  for (const tf of ['15m', '1h'] as Timeframe[]) {
    const exact = new Map<string, WadCandle[]>();
    for (const s of recent) {
      const w = swapPriceWad(s.sqrtPriceX96, s.stockIsToken0, UNISWAP!.decimals[s.symbol]!, UNISWAP!.usdg.decimals);
      if (w === null) continue;
      const t = bucketStart(tsOf.get(s.block)! * 1000, tf);
      const list = exact.get(s.symbol) ?? [];
      applyTick(list, t, w, 1000);
      exact.set(s.symbol, list);
    }
    for (const [symbol, list] of exact) {
      for (const c of list) {
        // Only buckets entirely inside the window are complete in the re-derivation.
        if (c.t <= fromTs * 1000 || c.t + TIMEFRAME_MS[tf] > headTs * 1000 || c.t < windowStart(now, tf)) continue;
        const row = await prisma.candle.findUnique({ where: { marketId_tf_t: { marketId: marketIds.get(symbol)!, tf, t: new Date(c.t) } } });
        const want = toCandle(c);
        compared++;
        if (!row) problems.push(`${symbol} ${tf} ${new Date(c.t).toISOString()}: missing`);
        else if (row.source !== 'uniswap' || Number(row.o) !== Number(want.o) || Number(row.h) !== Number(want.h) || Number(row.l) !== Number(want.l) || Number(row.c) !== Number(want.c)) {
          problems.push(`${symbol} ${tf} ${new Date(c.t).toISOString()}: stored ${row.o}/${row.h}/${row.l}/${row.c} (${row.source}) vs exact ${want.o}/${want.h}/${want.l}/${want.c}`);
        }
      }
    }
  }
  say('bucket comparison', { compared, problems: problems.length });
  for (const p of problems.slice(0, 20)) say('  MISMATCH', p);

  // Moving candles: in the last 24 hours, how many buckets per market have a range (high > low).
  const since = new Date(now - 86_400_000);
  for (const m of MARKETS) {
    const id = marketIds.get(m.symbol);
    if (!id) continue;
    const rows = await prisma.candle.findMany({ where: { marketId: id, tf: '15m', source: 'uniswap', t: { gte: since } }, orderBy: { t: 'asc' } });
    const moving = rows.filter((r) => !r.h.equals(r.l)).length;
    const counts = Object.fromEntries(await Promise.all(TIMEFRAMES.map(async (tf) => [tf, await prisma.candle.count({ where: { marketId: id, tf, source: 'uniswap' } })])));
    say(m.symbol, { last24h15m: rows.length, withRange: moving, lastClose: rows.at(-1)?.c.toFixed() ?? '-', stored: counts });
  }

  // The price source, once.
  const src = uniswapSource(client, UNISWAP!, log);
  const prices = await src.read(new Map(), Date.now());
  say('uniswap prices', Object.fromEntries(prices));

  // Live: two more steps.
  const before = dex.checkpoint!;
  await new Promise((r) => setTimeout(r, 5000));
  const n = await dex.step(ctx);
  say('live step', { from: before.toString(), to: dex.checkpoint?.toString(), swaps: n });

  await prisma.$disconnect();
  redis.disconnect();
  if (problems.length) {
    console.error(`FAILED: ${problems.length} of ${compared} buckets differ`);
    process.exit(1);
  }
  say(`OK: ${compared} buckets match the exact re-derivation; history built in ${(built / 1000).toFixed(0)} s`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
