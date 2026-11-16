/**
 * PRICE_SOURCE=uniswap: the curated pool data (packages/config uniswap-mainnet.json), the pool price math, the price
 * source, swap log reading, the block clock and the DEX candles (forward and backward merges give the same candles as
 * a straight aggregation of every swap at its exact block time).
 */
import { TIMEFRAMES, type Timeframe } from '@velum/config';
import { UNISWAP_MAINNET, UNI_MAX_FEE, buildUniswap, feePct, poolLabel, sqrtPriceToWad, virtualUsdgDepth, type UniPool } from '@velum/config/src/uniswap';
import mainnetJson from '@velum/config/robinhood-mainnet.json';
import uniswapJson from '@velum/config/uniswap-mainnet.json';
import { parseWad, toDecimalString } from '@velum/math';
import { encodeAbiParameters, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { testMac } from './__fixtures__/mac';
import { seriesKey, type WorkerContext } from './context';
import { DexCandles, boundariesIn, bucketOf, medianWad, swapPriceWad, windowStart } from './jobs/dex-candles';
import { open24hFromCandles } from './jobs/price-relay';
import { BlockClock, type BlockHeader } from './lib/block-clock';
import { bucketStart, candleMergeSql, mergeCandle, type WadCandle } from './lib/candles';
import type { Logger } from './lib/log';
import { UNI_MIN_DEPTH, getSwapLogs, limitedFetch, logsAdaptive, priceFromPools, uniswapSource } from './sources/uniswap';
import { loadEnv } from './env';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const Q96 = 1n << 96n;
/** Integer square root (floor). */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
/** sqrtPriceX96 for a USDG-per-stock price (decimal string) in a pool with the given token order. */
function sqrtFor(price: string, stockIsToken0: boolean): bigint {
  const w = parseWad(price)!; // USDG per stock, 1e18
  // raw = token1/token0 in base units; USDG 6 decimals, stock 18.
  // stock token0: raw = w * 1e6 / 1e18 / 1e18  -> sqrt(raw) * 2^96
  if (stockIsToken0) return isqrt((w * 10n ** 6n * Q96 * Q96) / 10n ** 36n);
  return isqrt((10n ** 36n * Q96 * Q96) / (w * 10n ** 6n));
}

describe('curated Uniswap pools (packages/config/uniswap-mainnet.json)', () => {
  const pools = Object.values(UNISWAP_MAINNET.pools).flat();
  it('every v4 pool id is keccak256(abi.encode(poolKey)) of a hookless pool', () => {
    for (const p of pools) {
      if (p.version !== 4) continue;
      const id = keccak256(
        encodeAbiParameters(
          [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
          [p.currency0, p.currency1, p.fee, p.tickSpacing, '0x0000000000000000000000000000000000000000'],
        ),
      );
      expect(id, `${p.symbol} v4 ${p.fee}`).toBe(p.id);
      expect(p.hooks).toBe('0x0000000000000000000000000000000000000000');
    }
  });
  it('v3 pools use the factory fee tiers and their tick spacing; every fee is at most 1%', () => {
    const spacing: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
    for (const p of pools) {
      expect(p.fee).toBeLessThanOrEqual(UNI_MAX_FEE);
      if (p.version === 3) expect(p.tickSpacing, `${p.symbol} v3 ${p.fee}`).toBe(spacing[p.fee]);
    }
  });
  it('pairs every listed market with USDG in Uniswap order, and has a chart pool per market', () => {
    const usdg = mainnetJson.tokens.USDG.address.toLowerCase();
    for (const [sym, list] of Object.entries(UNISWAP_MAINNET.pools)) {
      const stock = (mainnetJson.tokens as Record<string, { address: string }>)[sym]!.address.toLowerCase();
      expect(list.some((p) => p.chart)).toBe(true);
      for (const p of list) {
        expect(p.stock).toBe(stock);
        expect(p.usdg).toBe(usdg);
        expect(p.currency0 < p.currency1).toBe(true);
        expect(p.stockIsToken0).toBe(stock < usdg);
      }
    }
    expect(Object.keys(UNISWAP_MAINNET.pools).sort()).toEqual(Object.keys(mainnetJson.tokens).filter((k) => k !== 'USDG').sort());
  });
  it('refuses a hooked, high-fee, unknown or duplicate pool', () => {
    const base = JSON.parse(JSON.stringify(uniswapJson));
    const bad = (mutate: (j: typeof base) => void) => {
      const j = JSON.parse(JSON.stringify(base));
      mutate(j);
      return () => buildUniswap(j, mainnetJson.tokens);
    };
    expect(bad((j) => (j.pools.TSLA[0].fee = 900000))).toThrow(/at most 1%/);
    expect(bad((j) => (j.pools.NOPE = j.pools.TSLA))).toThrow(/not a mainnet Stock Token/);
    expect(bad((j) => j.pools.TSLA.push(j.pools.TSLA[0]))).toThrow(/duplicate/);
    expect(bad((j) => (j.pools.TSLA = j.pools.TSLA.map((p: { chart: boolean }) => ({ ...p, chart: false }))))).toThrow(/chart pool/);
    expect(bad((j) => (j.contracts.universalRouter = 'nope'))).toThrow(/universalRouter/);
    expect(bad((j) => (j.chainId = 1))).toThrow(/mainnet/);
  });
  it('labels fees the way Uniswap shows them', () => {
    expect([100, 500, 2400, 3000, 10000, 50].map(feePct)).toEqual(['0.01%', '0.05%', '0.24%', '0.30%', '1.00%', '0.005%']);
    expect(poolLabel(UNISWAP_MAINNET.pools.TSLA![0]!)).toBe('Uniswap v3, 0.30% pool');
  });
});

describe('pool price math', () => {
  it('turns sqrtPriceX96 into USDG per token for both token orders (within rounding)', () => {
    for (const [price, s0] of [
      ['390.92', true],
      ['390.92', false],
      ['0.0123', true],
      ['61234.5', false],
    ] as const) {
      const w = sqrtPriceToWad(sqrtFor(price, s0), s0, 18, 6)!;
      const want = parseWad(price)!;
      const diff = w > want ? w - want : want - w;
      expect(diff * 10n ** 9n < want, `${price} ${s0}`).toBe(true); // within 1e-9 relative
    }
  });
  it('matches a real pool reading (TSLA v3 0.30%, 2026-11-15)', () => {
    // slot0().sqrtPriceX96 of 0xf4ac…89e3 read on 2026-11-15 (stock is token0): about 387.1 USDG.
    const w = sqrtPriceToWad(1558820563917716297588129n, true, 18, 6)!;
    expect(Number(toDecimalString(w, 2))).toBeGreaterThan(380);
    expect(Number(toDecimalString(w, 2))).toBeLessThan(395);
  });
  it('rejects sqrt prices outside Uniswap’s range', () => {
    expect(sqrtPriceToWad(0n, true, 18, 6)).toBeNull();
    expect(sqrtPriceToWad(1n << 200n, true, 18, 6)).toBeNull();
  });
  it('measures in-range USDG depth on the USDG side', () => {
    expect(virtualUsdgDepth(0n, Q96, true)).toBe(0n);
    expect(virtualUsdgDepth(10n ** 12n, Q96, true)).toBe(10n ** 12n);
    expect(virtualUsdgDepth(10n ** 12n, 2n * Q96, false)).toBe(5n * 10n ** 11n);
  });
});

const tsla = UNISWAP_MAINNET.pools.TSLA!;
const chartTsla = tsla.filter((p) => p.chart);

describe('priceFromPools / uniswapSource', () => {
  it('takes the deepest pool above the minimum and rounds down to 4 decimals', () => {
    const deep = { pool: chartTsla[0]!, sqrtPriceX96: sqrtFor('390.123456', true), liquidity: 10n ** 20n };
    const shallow = { pool: chartTsla[1]!, sqrtPriceX96: sqrtFor('500', true), liquidity: 10n ** 15n };
    const r = priceFromPools([shallow, deep], 18, 6)!;
    expect(r.pool).toBe(chartTsla[0]);
    expect(Number(r.price)).toBeCloseTo(390.1234, 3);
    expect(r.price.split('.')[1]!.length).toBeLessThanOrEqual(4);
  });
  it('ignores pools with less than UNI_MIN_DEPTH in range', () => {
    const tiny = { pool: chartTsla[0]!, sqrtPriceX96: Q96 * 1000n, liquidity: 1n };
    expect(virtualUsdgDepth(tiny.liquidity, tiny.sqrtPriceX96, true) < UNI_MIN_DEPTH).toBe(true);
    expect(priceFromPools([tiny], 18, 6)).toBeNull();
  });
  it('reads one multicall, dates the price with the block time, and refuses a stale block', async () => {
    const now = Date.UTC(2026, 10, 15, 18, 0, 0);
    const mk = (blockTs: number) => ({
      multicall: async ({ contracts }: { contracts: Array<{ functionName: string; address: string }> }) =>
        contracts.map((c) => {
          if (c.functionName === 'getCurrentBlockTimestamp') return { status: 'success', result: BigInt(blockTs / 1000) };
          if (c.functionName === 'slot0' || c.functionName === 'getSlot0') return { status: 'success', result: [sqrtFor('390.5', true), 0, 0, 0] };
          return { status: 'success', result: 10n ** 20n };
        }),
    });
    const fresh = uniswapSource(mk(now - 2000) as never, UNISWAP_MAINNET, silent);
    const prices = await fresh.read(new Map(), now);
    expect(Number(prices.get('TSLA'))).toBeCloseTo(390.5, 2);
    expect(fresh.quoteTimes!.get('TSLA')).toBe(now - 2000);
    const stale = uniswapSource(mk(now - 120_000) as never, UNISWAP_MAINNET, silent);
    expect((await stale.read(new Map(), now)).size).toBe(0);
    const offChain = uniswapSource(mk(now) as never, UNISWAP_MAINNET, silent, () => false);
    expect((await offChain.read(new Map(), now)).size).toBe(0);
  });
});

describe('swap logs', () => {
  it('splits a refused range in halves and keeps block order', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const out = await logsAdaptive(
      async (a, b) => {
        calls.push([a, b]);
        if (b - a > 1000n) throw new Error('range too large');
        return [a];
      },
      0n,
      3999n,
    );
    expect(out).toEqual([...out].sort((x, y) => (x < y ? -1 : 1)));
    expect(calls.every(([a, b]) => a <= b)).toBe(true);
    expect(out.length).toBeGreaterThan(1);
  });
  it('reads v3 by address and v4 by pool id, drops foreign and removed logs, sorts by block and index', async () => {
    const v3 = tsla.find((p) => p.version === 3)!;
    const v4 = tsla.find((p) => p.version === 4)! as Extract<UniPool, { version: 4 }>;
    const seen: unknown[] = [];
    const client = {
      getLogs: async (q: { address: unknown; args?: { id?: unknown } }) => {
        seen.push(q);
        if (q.address === UNISWAP_MAINNET.contracts.poolManager)
          return [
            { address: UNISWAP_MAINNET.contracts.poolManager, blockNumber: 10n, logIndex: 1, args: { id: v4.id, sqrtPriceX96: 5n } },
            { address: UNISWAP_MAINNET.contracts.poolManager, blockNumber: 9n, logIndex: 0, args: { id: '0x' + '11'.repeat(32), sqrtPriceX96: 6n } },
          ];
        return [
          { address: v3.address, blockNumber: 10n, logIndex: 0, args: { sqrtPriceX96: 7n } },
          { address: v3.address, blockNumber: 8n, logIndex: 3, removed: true, args: { sqrtPriceX96: 8n } },
          { address: '0x' + '22'.repeat(20), blockNumber: 7n, logIndex: 0, args: { sqrtPriceX96: 9n } },
        ];
      },
    };
    const swaps = await getSwapLogs(client as never, UNISWAP_MAINNET, [v3, v4], 1n, 100n);
    expect(swaps.map((s) => [s.block, s.logIndex, s.sqrtPriceX96])).toEqual([
      [10n, 0, 7n],
      [10n, 1, 5n],
    ]);
    expect(seen).toHaveLength(2);
  });
  it('limits requests in flight', async () => {
    let active = 0;
    let peak = 0;
    const f = limitedFetch(2, (async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response('{}');
    }) as typeof fetch);
    await Promise.all(Array.from({ length: 8 }, () => f('x')));
    expect(peak).toBe(2);
  });
});

/** A synthetic chain: irregular block times with many blocks per second, as on Robinhood Chain. */
function makeChain(n: number, start: number, seed = 7): number[] {
  const ts: number[] = [];
  let t = start;
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    // Mostly 0 s (several blocks per second), sometimes a gap of up to 40 minutes.
    const r = x % 1000;
    t += r < 850 ? 0 : r < 990 ? 1 : 30 + (x % 2400);
    ts.push(t);
  }
  return ts;
}
const header = (ts: number[]) => async (n: bigint): Promise<BlockHeader> => {
  const t = ts[Number(n)];
  if (t === undefined) throw new Error(`no block ${n}`);
  return { number: n, timestamp: t, hash: `0x${n.toString(16).padStart(64, '0')}` };
};

describe('BlockClock.firstAtOrAfter', () => {
  it('finds the first block at or after a time, exactly, for every boundary', async () => {
    const ts = makeChain(20_000, 1_763_000_000);
    const clock = new BlockClock(header(ts));
    const lo = await clock.header(0n);
    const hi = await clock.header(BigInt(ts.length - 1));
    for (let t = lo.timestamp + 1; t <= hi.timestamp; t += 997) {
      const want = ts.findIndex((x) => x >= t);
      expect(await clock.firstAtOrAfter(t, lo, hi)).toBe(BigInt(want));
    }
  });
  it('refuses a time outside its bracket', async () => {
    const ts = makeChain(100, 1_763_000_000);
    const clock = new BlockClock(header(ts));
    const lo = await clock.header(10n);
    const hi = await clock.header(20n);
    await expect(clock.firstAtOrAfter(lo.timestamp, lo, hi)).rejects.toThrow();
  });
});

describe('bucketing by block', () => {
  it('assigns each block the bucket of its own timestamp', async () => {
    const ts = makeChain(30_000, Math.floor(Date.UTC(2026, 10, 14) / 1000));
    const nowMs = (ts[ts.length - 1]! + 60) * 1000;
    const clock = new BlockClock(header(ts));
    const lo = await clock.header(100n);
    const hi = await clock.header(29_000n);
    const per = boundariesIn(lo.timestamp, hi.timestamp, nowMs);
    for (const tf of TIMEFRAMES) {
      const located = await Promise.all(per[tf].map(async (t) => [t, await clock.firstAtOrAfter(t, lo, hi)] as const));
      for (let b = 101; b <= 29_000; b += 37) {
        const exact = bucketStart(ts[b]! * 1000, tf);
        const got = bucketOf(BigInt(b), lo.timestamp, located, tf, nowMs);
        expect(got, `${tf} block ${b}`).toBe(exact < windowStart(nowMs, tf) ? null : exact);
      }
    }
  });
});

describe('candle merges', () => {
  const w = (s: string) => parseWad(s)!;
  it('append keeps the open and takes the close; prepend takes the open and keeps the close', () => {
    const s: WadCandle[] = [{ t: 0, o: w('10'), h: w('12'), l: w('9'), c: w('11') }];
    mergeCandle(s, { t: 0, o: w('11'), h: w('15'), l: w('10'), c: w('14') }, 'append');
    expect(s[0]).toEqual({ t: 0, o: w('10'), h: w('15'), l: w('9'), c: w('14') });
    mergeCandle(s, { t: 0, o: w('8'), h: w('9'), l: w('7'), c: w('9') }, 'prepend');
    expect(s[0]).toEqual({ t: 0, o: w('8'), h: w('15'), l: w('7'), c: w('14') });
    mergeCandle(s, { t: -10, o: w('1'), h: w('1'), l: w('1'), c: w('1') }, 'prepend', 2);
    expect(s.map((c) => c.t)).toEqual([-10, 0]);
    mergeCandle(s, { t: -20, o: w('1'), h: w('1'), l: w('1'), c: w('1') }, 'prepend', 2);
    expect(s.map((c) => c.t)).toEqual([-10, 0]);
  });
  it('builds one INSERT per batch with the right merge for each mode', () => {
    const row = { marketId: 'm', tf: '1h' as Timeframe, t: 0, o: '1', h: '2', l: '1', c: '2' };
    const a = candleMergeSql([row], 'uniswap', 'append').sql;
    const p = candleMergeSql([row], 'uniswap', 'prepend').sql;
    expect(a).toMatch(/"o" = "Candle"\."o"/);
    expect(a).toMatch(/"c" = EXCLUDED\."c"/);
    expect(p).toMatch(/"o" = EXCLUDED\."o"/);
    expect(p).toMatch(/"c" = "Candle"\."c"/);
    expect(() => candleMergeSql([], 'uniswap', 'append')).toThrow();
  });
  it('median and swap price helpers', () => {
    expect(medianWad([3n, 1n, 2n])).toBe(2n);
    expect(medianWad([4n, 1n, 2n, 3n])).toBe(2n);
    expect(swapPriceWad(sqrtFor('390.5', true), true, 18, 6)! % 10n ** 14n).toBe(0n);
  });
  it('open24hFromCandles: the last close at or before the time, or null', () => {
    const s: WadCandle[] = [
      { t: 0, o: w('1'), h: w('1'), l: w('1'), c: w('2') },
      { t: 900_000, o: w('3'), h: w('3'), l: w('3'), c: w('4') },
    ];
    expect(open24hFromCandles(s, -1)).toBeNull();
    expect(open24hFromCandles(s, 100)).toBe('2');
    expect(open24hFromCandles(s, 900_000)).toBe('4');
  });
});

/** In-memory stand-ins for the parts of Prisma and Redis the DEX candles use. */
function fakeStore() {
  const candles = new Map<string, { marketId: string; tf: string; t: number; o: bigint; h: bigint; l: bigint; c: bigint; source: string }>();
  const checkpoints = new Map<string, { block: bigint; blockHash: string }>();
  const parseRows = (q: { values: unknown[]; sql: string }) => {
    const v = q.values;
    const rows: Array<{ marketId: string; tf: string; t: number; o: bigint; h: bigint; l: bigint; c: bigint; source: string }> = [];
    for (let i = 0; i < v.length; i += 8) {
      const t = Date.parse(String(v[i + 2]) + 'Z');
      rows.push({ marketId: String(v[i]), tf: String(v[i + 1]), t, o: parseWad(String(v[i + 3]))!, h: parseWad(String(v[i + 4]))!, l: parseWad(String(v[i + 5]))!, c: parseWad(String(v[i + 6]))!, source: String(v[i + 7]) });
    }
    const prepend = /"o" = EXCLUDED/.test(q.sql);
    for (const r of rows) {
      const k = `${r.marketId}:${r.tf}:${r.t}`;
      const cur = candles.get(k);
      if (!cur) candles.set(k, r);
      else candles.set(k, { ...cur, o: prepend ? r.o : cur.o, h: r.h > cur.h ? r.h : cur.h, l: r.l < cur.l ? r.l : cur.l, c: prepend ? cur.c : r.c, source: r.source });
    }
  };
  const tx = {
    indexerCheckpoint: {
      updateMany: async ({ where, data }: { where: { deployment: string; block: bigint; blockHash?: string }; data: { block: bigint; blockHash: string } }) => {
        const cp = checkpoints.get(where.deployment);
        if (!cp || cp.block !== where.block || (where.blockHash !== undefined && cp.blockHash !== where.blockHash)) return { count: 0 };
        checkpoints.set(where.deployment, data);
        return { count: 1 };
      },
    },
    $executeRaw: async (q: { values: unknown[]; sql: string }) => {
      parseRows(q);
      return 1;
    },
  };
  const prisma = {
    indexerCheckpoint: {
      findUnique: async ({ where }: { where: { chainId_deployment: { deployment: string } } }) => {
        const cp = checkpoints.get(where.chainId_deployment.deployment);
        return cp ? { ...cp } : null;
      },
      deleteMany: () => ({ kind: 'deleteCp' }),
      create: ({ data }: { data: { deployment: string; block: bigint; blockHash: string } }) => ({ kind: 'createCp', data }),
    },
    candle: { deleteMany: () => ({ kind: 'deleteCandles' }) },
    $transaction: async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (t: typeof tx) => Promise<unknown>)(tx);
      for (const op of arg as Array<{ kind: string; data?: { deployment: string; block: bigint; blockHash: string } }>) {
        if (op.kind === 'deleteCp') checkpoints.clear();
        if (op.kind === 'deleteCandles') candles.clear();
        if (op.kind === 'createCp') checkpoints.set(op.data!.deployment, { block: op.data!.block, blockHash: op.data!.blockHash });
      }
      return [];
    },
  };
  const redis = {
    pipeline() {
      return { set: () => this.pipeline(), exec: async () => [] };
    },
    set: async () => 'OK',
  };
  return { prisma, redis, candles, checkpoints };
}

describe('DexCandles on a synthetic chain', () => {
  // 60k blocks, 1-in-40 has a swap of a TSLA chart pool; prices random-walk around 390.
  const ts = makeChain(60_000, Math.floor(Date.UTC(2026, 10, 12) / 1000), 3);
  const nowMs = (ts[ts.length - 1]! + 30) * 1000;
  const v3 = chartTsla.find((p) => p.version === 3)! as Extract<UniPool, { version: 3 }>;
  const swaps: Array<{ block: bigint; logIndex: number; price: string }> = [];
  let x = 11;
  let price = 390;
  for (let b = 1; b < ts.length; b++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    if (x % 40 !== 0) continue;
    price *= 1 + ((x % 2001) - 1000) / 400_000;
    swaps.push({ block: BigInt(b), logIndex: 0, price: price.toFixed(6) });
  }
  const client = (head: () => bigint) => ({
    getBlockNumber: async () => head(),
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      const h = await header(ts)(blockNumber);
      return { number: h.number, timestamp: BigInt(h.timestamp), hash: h.hash };
    },
    getLogs: async (q: { address: unknown; fromBlock: bigint; toBlock: bigint }) =>
      q.address === UNISWAP_MAINNET.contracts.poolManager
        ? []
        : swaps.filter((s) => s.block >= q.fromBlock && s.block <= q.toBlock).map((s) => ({ address: v3.address, blockNumber: s.block, logIndex: s.logIndex, args: { sqrtPriceX96: sqrtFor(s.price, true) } })),
  });
  /** What every candle must be: each swap at its exact block time, straight aggregation. */
  function expected(tf: Timeframe, fromBlock: number, toBlock: number) {
    const out = new Map<number, WadCandle>();
    for (const s of swaps) {
      if (s.block < BigInt(fromBlock) || s.block > BigInt(toBlock)) continue;
      const t = bucketStart(ts[Number(s.block)]! * 1000, tf);
      if (t < windowStart(nowMs, tf)) continue;
      const w = swapPriceWad(sqrtFor(s.price, true), true, 18, 6)!;
      const c = out.get(t);
      out.set(t, c ? { t, o: c.o, h: c.h > w ? c.h : w, l: c.l < w ? c.l : w, c: w } : { t, o: w, h: w, l: w, c: w });
    }
    return out;
  }
  const ctxFor = (store: ReturnType<typeof fakeStore>) =>
    ({
      env: {} as WorkerContext['env'],
      prisma: store.prisma,
      redis: store.redis,
      log: silent,
      source: { name: 'uniswap', read: async () => new Map() },
      marketIds: new Map([['TSLA', 'm-tsla']]),
      snapshots: new Map(),
      open24h: new Map(),
      lastOpenRefresh: 0,
      series: new Map(),
      lastTickAt: new Map(),
      mac: testMac,
      enqueueCandles: async () => undefined,
    }) as unknown as WorkerContext;

  it('history (backwards) then live (forwards) gives exactly the straight aggregation, in Postgres and in memory', async () => {
    const store = fakeStore();
    const ctx = ctxFor(store);
    let head = 40_000n;
    const cfg = { ...UNISWAP_MAINNET, pools: { TSLA: [v3] } };
    const dex = new DexCandles({ client: client(() => head + 2n) as never, cfg, chainId: 4663, now: () => nowMs });
    while (!dex.historyDone) await dex.step(ctx, 60_000);
    head = 59_990n;
    await dex.step(ctx, 60_000);
    expect(dex.checkpoint).toBe(59_990n);
    for (const tf of TIMEFRAMES) {
      const want = expected(tf, 1, 59_990);
      const got = [...store.candles.values()].filter((c) => c.tf === tf);
      expect(want.size, `${tf} has candles to compare`).toBeGreaterThan(3);
      expect(got.length, tf).toBe(want.size);
      for (const c of got) {
        const e = want.get(c.t)!;
        expect([c.o, c.h, c.l, c.c], `${tf} ${new Date(c.t).toISOString()}`).toEqual([e.o, e.h, e.l, e.c]);
        expect(c.source).toBe('uniswap');
      }
      const mem = ctx.series.get(seriesKey('TSLA', tf)) ?? [];
      const tail = [...want.values()].sort((a, b) => a.t - b.t).slice(-mem.length);
      expect(mem).toEqual(tail);
    }
  });

  it('resumes from its checkpoints after a restart without double counting', async () => {
    const store = fakeStore();
    const ctx = ctxFor(store);
    const cfg = { ...UNISWAP_MAINNET, pools: { TSLA: [v3] } };
    let head = 30_000n;
    const first = new DexCandles({ client: client(() => head + 2n) as never, cfg, chainId: 4663, now: () => nowMs });
    await first.step(ctx, 0); // starts both cursors at the head; no history range within a zero budget
    head = 45_000n;
    // A new process: memory is rebuilt from what Postgres holds.
    const series = new Map<string, WadCandle[]>();
    for (const tf of TIMEFRAMES) {
      const list = [...store.candles.values()].filter((c) => c.tf === tf).sort((a, b) => a.t - b.t).map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }));
      series.set(seriesKey('TSLA', tf), list.slice(-300));
    }
    ctx.series = series;
    const second = new DexCandles({ client: client(() => head + 2n) as never, cfg, chainId: 4663, now: () => nowMs });
    while (!second.historyDone) await second.step(ctx, 60_000);
    for (const tf of TIMEFRAMES) {
      const want = expected(tf, 1, 45_000);
      const got = [...store.candles.values()].filter((c) => c.tf === tf);
      expect(got.length, tf).toBe(want.size);
      for (const c of got) expect([c.o, c.h, c.l, c.c]).toEqual(Object.values(want.get(c.t)!).slice(1));
    }
  });
});

describe('workers environment', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@localhost/db', REDIS_URL: 'redis://:p@localhost:6379' };
  it('accepts PRICE_SOURCE=uniswap on mainnet only', () => {
    // This test process runs the testnet config, so a mainnet env fails only on its CHAIN_ID, never on PRICE_SOURCE.
    try {
      loadEnv({ ...base, VELUM_NETWORK: 'mainnet', PRICE_SOURCE: 'uniswap' } as NodeJS.ProcessEnv);
    } catch (err) {
      expect((err as Error).message).not.toMatch(/PRICE_SOURCE/);
    }
    expect(() => loadEnv({ ...base, PRICE_SOURCE: 'uniswap' } as NodeJS.ProcessEnv)).toThrow(/PRICE_SOURCE=uniswap needs VELUM_NETWORK=mainnet/);
    expect(() => loadEnv({ ...base, PRICE_SOURCE: 'pancake' } as NodeJS.ProcessEnv)).toThrow(/"uniswap"/);
  });
});

describe('candleMergeSql on Postgres', () => {
  // Needs TEST_DATABASE_URL pointing at a migrated scratch database. Skipped otherwise.
  it.skipIf(!process.env.TEST_DATABASE_URL)('append and prepend merge a bucket exactly like mergeCandle', async () => {
    const { PrismaClient } = await import('@velum/db');
    const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
    try {
      const m = await prisma.market.upsert({ where: { symbol: 'ZZMERGE' }, create: { symbol: 'ZZMERGE', name: 'merge test' }, update: {}, select: { id: true } });
      await prisma.candle.deleteMany({ where: { marketId: m.id } });
      const t = Date.UTC(2026, 10, 15, 10);
      const row = (o: string, h: string, l: string, c: string) => ({ marketId: m.id, tf: '1h' as Timeframe, t, o, h, l, c });
      await prisma.$executeRaw(candleMergeSql([row('10', '12', '9', '11')], 'uniswap', 'append'));
      await prisma.$executeRaw(candleMergeSql([row('11', '15', '10', '14')], 'uniswap', 'append'));
      await prisma.$executeRaw(candleMergeSql([row('8', '9', '7', '9')], 'uniswap', 'prepend'));
      const got = await prisma.candle.findUniqueOrThrow({ where: { marketId_tf_t: { marketId: m.id, tf: '1h', t: new Date(t) } } });
      expect([got.o, got.h, got.l, got.c].map((d) => d.toFixed())).toEqual(['8', '15', '7', '14']);
      expect(got.source).toBe('uniswap');
      await prisma.candle.deleteMany({ where: { marketId: m.id } });
      await prisma.market.delete({ where: { id: m.id } });
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe('24h open with the DEX source (regression: one market without history zeroed every 24h change)', () => {
  const w = (x: string) => parseWad(x)!;
  const NOW = Date.UTC(2026, 10, 16, 5, 0, 0);
  const since = NOW - 86_400_000;
  it('falls back to coarser candles that ended by then, never to a still-open bucket', async () => {
    const { open24hFromSeries } = await import('./jobs/price-relay');
    const hour = 3_600_000;
    const s1h: WadCandle[] = [
      { t: since - 2 * hour, o: w('1'), h: w('1'), l: w('1'), c: w('100') },
      { t: since - hour, o: w('1'), h: w('1'), l: w('1'), c: w('101') },
      { t: since - 1000 - (since % hour), o: w('1'), h: w('1'), l: w('1'), c: w('999') },
    ].filter((c, i, a) => a.findIndex((x) => x.t === c.t) === i);
    expect(open24hFromSeries((tf) => (tf === '1h' ? s1h : []), since)).toBe('101');
    expect(open24hFromSeries(() => [], since)).toBeNull();
  });
  it('only markets without candles fall back to ticks; the others keep their candle open', async () => {
    const { refreshOpen24h } = await import('./jobs/price-relay');
    const queried: string[] = [];
    const ctx = {
      source: { name: 'uniswap' },
      lastOpenRefresh: 0,
      marketIds: new Map([
        ['TSLA', 'm-tsla'],
        ['NFLX', 'm-nflx'],
      ]),
      series: new Map([[seriesKey('TSLA', '15m'), [{ t: since - 600_000, o: w('380'), h: w('380'), l: w('380'), c: w('380.5') }]]]),
      open24h: new Map<string, string>(),
      prisma: {
        priceTick: {
          findFirst: async ({ where }: { where: { marketId: string } }) => {
            queried.push(where.marketId);
            return { price: { toFixed: () => '61.2' }, at: new Date(NOW - 60_000) };
          },
        },
      },
    } as unknown as WorkerContext;
    await refreshOpen24h(ctx, NOW);
    expect(ctx.open24h.get('TSLA')).toBe('380.5');
    expect(ctx.open24h.get('NFLX')).toBe('61.2');
    expect(queried).toEqual(['m-nflx']);
  });
});
