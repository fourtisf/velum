/**
 * Display-only on-chain DEX prices (packages/config/src/dex.ts, src/dex): price math with exact decimals and
 * uiMultiplier tokens, the outlier guards, the liquidity threshold, and the indexer against Postgres with a fake RPC.
 */
import {
  DEX_CACHE_KEY,
  DEX_PARAMS,
  DEX_SWAP_TOPIC,
  classifyDexTrade,
  decToWad,
  dexLiquidityOk,
  dexPoolsOf,
  dexToken,
  dexTradePrice,
  medianWad,
  parseDexSnapshot,
  wadToDec,
  type DexPool,
} from '@velum/config';
import type { PrismaClient } from '@velum/db';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mainnetTestMac, openJson } from '../__fixtures__/mac';
import { DEFAULT_DEX_SETTINGS, checkpointKey, decodeSwap, interpolateAt, publishSnapshots, runDex, verifyPools, type DexContext } from './indexer';
import type { DexBlock, DexLog, DexRpc } from './rpc';

const W = (s: string) => decToWad(s)!;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const USDG = (n: string) => BigInt(Math.round(Number(n) * 1e6)); // 6 decimals
const TOK = (n: string) => W(n); // 18 decimals

describe('DEX trade price: exact decimals, per token', () => {
  it('USDG token0 (6 decimals), Stock Token token1 (18): a buy of 1 token for 161.27 USDG is 161.27 per token', () => {
    const p = dexTradePrice(USDG('161.27'), -TOK('1'), true)!;
    expect(wadToDec(p.price)).toBe('161.27');
    expect(wadToDec(p.notional)).toBe('161.27');
    expect(wadToDec(p.qty)).toBe('1');
    expect(p.side).toBe('buy');
  });

  it('Stock Token token0, USDG token1 (TSLA and AMZN sort before USDG): a sell of 2 tokens for 774.22 USDG is 387.11', () => {
    const p = dexTradePrice(TOK('2'), -USDG('774.22'), false)!;
    expect(wadToDec(p.price)).toBe('387.11');
    expect(p.side).toBe('sell');
  });

  it('rounds down exactly (bigint), never through floats', () => {
    // 100 USDG for 3 tokens: 33.333333333333333333 (18 decimals, floored).
    expect(wadToDec(dexTradePrice(USDG('100'), -TOK('3'), true)!.price)).toBe('33.333333333333333333');
    // 1 raw USDG unit for 7 raw token units: still exact.
    expect(dexTradePrice(1n, -7n, true)!.price).toBe((10n ** 12n * 10n ** 18n) / 7n);
  });

  it('other decimals scale both sides to 18 (a token with 8 decimals, a quote with 18)', () => {
    expect(wadToDec(dexTradePrice(USDG('50'), -200_000_000n, true, 8)!.price)).toBe('25'); // 2 tokens of 8 decimals
    expect(wadToDec(dexTradePrice(W('50'), -TOK('2'), true, 18, 18)!.price)).toBe('25');
  });

  it('uiMultiplier tokens: on-chain amounts are per token, so the price is per token, the basis of tokenBid/tokenAsk', () => {
    // NVDA's uiMultiplier was 1.000775159164630600 on 2026-11-15; Robinhood's tokenBid is bid x currentMultiplier.
    const multiplier = W('1.0007751591646306');
    const bidPerShare = W('155.03');
    const tokenBid = (bidPerShare * multiplier) / 10n ** 18n; // what the official snapshot holds (token basis)
    // A swap of 1 token for 161.27 USDG: 161.27 per token whatever the multiplier is; no adjustment applied.
    const p = dexTradePrice(USDG('161.27'), -TOK('1'), true)!;
    expect(wadToDec(p.price)).toBe('161.27');
    // Compared with the token-basis quote (the snapshot), the move is +3.95%: within the 25% bound.
    expect(classifyDexTrade(p, tokenBid, [])).toBe('ok');
    // Per share it would be price / multiplier, a different number: the API never mixes the two bases.
    expect(wadToDec((p.price * 10n ** 18n) / multiplier).startsWith('161.14')).toBe(true);
  });

  it('a log with both amounts the same sign or a zero side carries no price', () => {
    expect(dexTradePrice(USDG('1'), TOK('1'), true)).toBeNull();
    expect(dexTradePrice(0n, -TOK('1'), true)).toBeNull();
    expect(dexTradePrice(USDG('1'), 0n, true)).toBeNull();
  });

  it('decodes a real Swap log of the NVDA pool (2026-11-15) and finds it is dust', () => {
    const pool = dexPoolsOf('mainnet').NVDA!;
    const log: DexLog = {
      address: pool.pool,
      topics: [DEX_SWAP_TOPIC, '0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2', '0x000000000000000000000000caf681a66d020601342297493863e78c959e5cb2'],
      data: '0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffbf0000000000000000000000000000000000000000000000000000005df3e9b059900000000000000000000000000000000000133a08835324ebc3d44d5f736a5b90000000000000000000000000000000000000000000000001ee32bf0e452bd4900000000000000000000000000000000000000000000000000000000000370d4',
      blockNumber: 0x6dc7d68n,
      logIndex: 0xab,
      transactionHash: '0xe7dd3fceba7cc4fe7124228e9b46d602766647450df9863acf616818042a4378',
    };
    const t = decodeSwap(log, pool, 1)!;
    // 0.00104 USDG out of the pool for 0.0000064498... NVDA in: about 161.2 per token, far below the dust limit.
    expect(Number(wadToDec(t.price))).toBeGreaterThan(161);
    expect(Number(wadToDec(t.price))).toBeLessThan(162);
    expect(classifyDexTrade(t, null, [])).toBe('dust');
  });
});

describe('DEX outlier guards', () => {
  const t = (price: string, notional = '1000') => ({ price: W(price), notional: W(notional) });

  it('ignores dust trades below the minimum notional', () => {
    expect(classifyDexTrade(t('100', '24.99'), null, [])).toBe('dust');
    expect(classifyDexTrade(t('100', DEX_PARAMS.dustUsdg), null, [])).toBe('ok');
  });

  it('bounds a trade against the last official quote (25%)', () => {
    expect(classifyDexTrade(t('125'), W('100'), [])).toBe('ok');
    expect(classifyDexTrade(t('125.01'), W('100'), [])).toBe('quoteBound');
    expect(classifyDexTrade(t('74.99'), W('100'), [])).toBe('quoteBound');
    expect(classifyDexTrade(t('150'), null, [])).toBe('ok'); // no quote: only the median applies
  });

  it('a single outlier never passes the rolling median (3%); a sustained move passes once it is the majority', () => {
    const window = Array(8).fill(W('100'));
    expect(classifyDexTrade(t('103'), W('100'), window)).toBe('ok');
    expect(classifyDexTrade(t('110'), W('100'), window)).toBe('median');
    // A real move to 110: the first four trades there are held back, the fifth (majority of nine) passes.
    const w: bigint[] = [...window];
    const statuses: string[] = [];
    for (let i = 0; i < 6; i++) {
      const s = classifyDexTrade(t('110'), W('100'), w);
      statuses.push(s);
      w.push(W('110'));
      w.splice(0, w.length - (DEX_PARAMS.medianWindow - 1));
    }
    expect(statuses).toEqual(['median', 'median', 'median', 'median', 'ok', 'ok']);
  });

  it('the median starts with three trades and is always one of the prices', () => {
    expect(classifyDexTrade(t('200'), null, [W('100')])).toBe('ok');
    expect(classifyDexTrade(t('200'), null, [W('100'), W('100')])).toBe('median');
    expect(medianWad([W('3'), W('1'), W('2'), W('4')])).toBe(W('2'));
    expect(medianWad([])).toBeNull();
  });

  it('flags a pool under the liquidity thresholds (50,000 USDG total, 2,500 each side)', () => {
    expect(dexLiquidityOk(W('25000'), W('25000'))).toBe(true);
    expect(dexLiquidityOk(W('24999'), W('25000'))).toBe(false);
    expect(dexLiquidityOk(W('2499'), W('100000'))).toBe(false);
    expect(dexLiquidityOk(W('100000'), W('2499'))).toBe(false);
  });
});

describe('DEX snapshot (Redis payload) validation', () => {
  const pool = '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3';
  const now = Date.UTC(2026, 10, 15, 17);
  const close = { end: Date.UTC(2026, 10, 14, 1), price: '161.1', at: Date.UTC(2026, 10, 14, 0, 58) };
  const good = { symbol: 'NVDA', pool, price: '161.27', tradeAt: now - 60_000, block: 115_000_000, liquidityUsdg: '1922052.5', usdgSide: '408421', tokenSideUsdg: '1513631.5', belowThreshold: false, liquidityAt: now - 1000, checkedAt: now, close };
  it('accepts a well-formed snapshot and refuses anything off', () => {
    expect(parseDexSnapshot(JSON.stringify(good), 'NVDA', pool, now)).toEqual(good);
    expect(parseDexSnapshot(JSON.stringify({ ...good, pool: '0x0000000000000000000000000000000000000001' }), 'NVDA', pool, now)).toBeNull();
    expect(parseDexSnapshot(JSON.stringify({ ...good, symbol: 'TSLA' }), 'NVDA', pool, now)).toBeNull();
    expect(parseDexSnapshot(JSON.stringify({ ...good, price: '1e3' }), 'NVDA', pool, now)).toBeNull();
    expect(parseDexSnapshot(JSON.stringify({ ...good, price: '0' }), 'NVDA', pool, now)).toBeNull();
    expect(parseDexSnapshot(JSON.stringify({ ...good, tradeAt: now + 60_000 }), 'NVDA', pool, now)).toBeNull();
    expect(parseDexSnapshot(JSON.stringify({ ...good, belowThreshold: 'no' }), 'NVDA', pool, now)).toBeNull();
    expect(parseDexSnapshot(JSON.stringify({ ...good, close: null }), 'NVDA', pool, now)?.close).toBeNull();
    expect(parseDexSnapshot(JSON.stringify({ ...good, close: { ...close, price: 'x' } }), 'NVDA', pool, now)).toBeNull();
    expect(parseDexSnapshot(JSON.stringify({ ...good, close: { ...close, at: close.end + 1 } }), 'NVDA', pool, now)).toBeNull();
    expect(parseDexSnapshot('{', 'NVDA', pool, now)).toBeNull();
    expect(parseDexSnapshot('x'.repeat(5000), 'NVDA', pool, now)).toBeNull();
  });
});

describe('DEX pools configuration', () => {
  it('mainnet has one Stock Token / USDG pool per market, testnet none; token order matches the addresses', () => {
    const pools = dexPoolsOf('mainnet');
    expect(Object.keys(pools).sort()).toEqual(['AAPL', 'AMD', 'AMZN', 'COIN', 'META', 'MSFT', 'NFLX', 'NVDA', 'PLTR', 'TSLA']);
    expect(dexPoolsOf('testnet')).toEqual({});
    const usdg = dexToken('USDG')!.address;
    for (const p of Object.values(pools)) expect(p.usdgIsToken0).toBe(usdg < dexToken(p.symbol)!.address);
    expect(dexToken('USDG')!.decimals).toBe(6);
    expect(dexToken('NVDA')!.decimals).toBe(18);
  });

  it('verifyPools keeps only pools whose token0/token1 match', async () => {
    const pools = Object.values(dexPoolsOf('mainnet')).filter((p) => p.symbol === 'NVDA' || p.symbol === 'TSLA');
    const word = (a: string) => '0x' + a.slice(2).padStart(64, '0');
    const rpc = {
      call: async (to: string, data: string) => {
        if (to === pools.find((p) => p.symbol === 'NVDA')!.pool) return word(data === '0x0dfe1681' ? dexToken('USDG')!.address : dexToken('NVDA')!.address);
        return word(dexToken('AMZN')!.address); // the TSLA entry points at the wrong contract
      },
    } as unknown as DexRpc;
    expect((await verifyPools(rpc, pools, silent)).map((p) => p.symbol)).toEqual(['NVDA']);
  });

  it('interpolates block times between two headers', () => {
    const a: DexBlock = { number: 1000n, hash: '0xa', timestamp: 1_000_000 };
    const b: DexBlock = { number: 2000n, hash: '0xb', timestamp: 1_000_100 };
    expect(interpolateAt(1500n, a, b)).toBe(1_000_050_000);
    expect(interpolateAt(1000n, a, a)).toBe(1_000_000_000);
  });
});

/* ---------- The indexer against Postgres (TEST_DATABASE_URL) with a fake RPC ---------- */
const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB)('DEX indexer (Postgres, fake RPC)', () => {
  let prisma: PrismaClient;
  const pool: DexPool = dexPoolsOf('mainnet').NVDA!;
  const CHAIN = 999_4663; // its own checkpoint key, apart from anything else in the test database
  const T = Date.UTC(2026, 10, 14, 12, 0, 0); // Saturday noon UTC: the market is closed
  const store = new Map<string, string>();
  const redis = { pipeline: () => ({ set: (k: string, v: string) => void store.set(k, v), exec: async () => [] }) } as unknown as Redis;
  let hashes = new Map<bigint, string>();
  let logs: DexLog[] = [];
  const blockAt = (n: bigint): DexBlock => ({ number: n, hash: hashes.get(n) ?? `0x${n.toString(16)}`, timestamp: Math.floor(T / 1000) + Number(n - 1000n) / 10 });
  const swapLog = (n: bigint, i: number, usdg: string, tokens: string): DexLog => {
    const enc = (v: bigint) => BigInt.asUintN(256, v).toString(16).padStart(64, '0');
    return {
      address: pool.pool,
      topics: [DEX_SWAP_TOPIC, '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)],
      data: '0x' + enc(USDG(usdg)) + enc(-TOK(tokens)) + enc(1n) + enc(1n) + enc(0n),
      blockNumber: n,
      logIndex: i,
      transactionHash: `0x${n.toString(16).padStart(8, '0')}${String(i).padStart(56, '0')}`,
    };
  };
  let head = 1000n;
  const rpc: DexRpc = {
    confirmedHead: async () => blockAt(head),
    block: async (n) => blockAt(n),
    logs: async (_a, _t, from, to) => logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to),
    call: async (to) => (to === dexToken('USDG')!.address ? '0x' + (400_000n * 10n ** 6n).toString(16) : '0x' + (9_000n * 10n ** 18n).toString(16)),
  };
  const ctx = (): DexContext => ({
    prisma,
    redis,
    mac: mainnetTestMac,
    log: silent,
    rpc,
    chainId: CHAIN,
    pools: [pool],
    quote: () => '155.145',
    settings: { ...DEFAULT_DEX_SETTINGS, backfillBlocks: 1000n, chunkBlocks: 300n, maxChunksPerRun: 10 },
    liquidity: new Map(),
    now: () => T + 3_600_000,
  });
  const cleanup = async () => {
    await prisma.dexTrade.deleteMany({ where: { pool: pool.pool } });
    await prisma.dexCandle.deleteMany({ where: { pool: pool.pool } });
    await prisma.dexCheckpoint.deleteMany({ where: { key: checkpointKey(CHAIN, [pool]) } });
  };

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@velum/db');
    prisma = new Client({ datasources: { db: { url: DB! } } });
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('indexes confirmed swaps, applies the guards, builds candles and publishes the last trade with liquidity', async () => {
    hashes = new Map();
    // Blocks 100..1000 (0.1 s each): ten trades around 161, one dust trade, one outlier at +20% (within the quote
    // bound of 25%, rejected by the median), all in the first 15-minute bucket of the window.
    logs = [
      ...[161.2, 161.3, 161.1, 161.25, 161.4].map((p, i) => swapLog(200n + BigInt(i) * 10n, 0, String(p * 10), '10')),
      swapLog(260n, 0, '193.5', '1'), // +20%: outlier
      swapLog(270n, 0, '1.61', '0.01'), // dust
      ...[161.5, 161.45, 161.6].map((p, i) => swapLog(300n + BigInt(i) * 10n, 1, String(p * 10), '10')),
    ];
    head = 1000n;
    const r = await runDex(ctx());
    expect(r.trades).toBe(10);
    const rows = await prisma.dexTrade.findMany({ where: { pool: pool.pool }, orderBy: [{ block: 'asc' }, { logIndex: 'asc' }] });
    expect(rows.map((x) => x.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'median', 'dust', 'ok', 'ok', 'ok']);
    expect(rows[0]!.price.toFixed()).toBe('161.2');
    const c15 = await prisma.dexCandle.findMany({ where: { pool: pool.pool, tf: '15m' } });
    expect(c15.length).toBe(1);
    expect(c15[0]).toMatchObject({ trades: 8, symbol: 'NVDA' });
    expect([c15[0]!.o.toFixed(), c15[0]!.h.toFixed(), c15[0]!.l.toFixed(), c15[0]!.c.toFixed()]).toEqual(['161.2', '161.6', '161.1', '161.6']);
    const cp = await prisma.dexCheckpoint.findUnique({ where: { key: checkpointKey(CHAIN, [pool]) } });
    expect(cp?.block).toBe(1000n);
    const snap = openJson<Record<string, unknown>>(store.get(DEX_CACHE_KEY('NVDA')), DEX_CACHE_KEY('NVDA'), mainnetTestMac);
    expect(snap).toMatchObject({ symbol: 'NVDA', pool: pool.pool, price: '161.6', block: 320, belowThreshold: false, usdgSide: '400000' });
    // The trades are from Saturday noon, long after Friday's 20:00 EST close: no close price for the pool.
    expect(snap?.close).toBeNull();
    // 9,000 tokens at the last trade (161.6) plus 400,000 USDG.
    expect(snap?.liquidityUsdg).toBe('1854400');
  });

  it('is idempotent: indexing the same blocks again changes nothing', async () => {
    await prisma.dexCheckpoint.deleteMany({ where: { key: checkpointKey(CHAIN, [pool]) } });
    await runDex(ctx());
    expect(await prisma.dexTrade.count({ where: { pool: pool.pool } })).toBe(10);
    expect(await prisma.dexCandle.count({ where: { pool: pool.pool, tf: '15m' } })).toBe(1);
  });

  it('rewinds and rebuilds when a block hash below the checkpoint changes (reorg)', async () => {
    // The chain now says block 1000 has another hash and the trades of blocks 300-320 are gone.
    hashes = new Map([[1000n, '0xdead']]);
    logs = logs.filter((l) => l.blockNumber < 300n);
    const r = await runDex({ ...ctx(), settings: { ...ctx().settings, rewindBlocks: 750n } });
    expect(r.reorg).toBe(true);
    expect(await prisma.dexTrade.count({ where: { pool: pool.pool, block: { gt: 250n } } })).toBe(0);
    const c15 = await prisma.dexCandle.findMany({ where: { pool: pool.pool, tf: '15m' } });
    expect(c15[0]!.c.toFixed()).toBe('161.4'); // rebuilt without the rewound trades
    // The next run indexes from the rewound checkpoint again.
    const again = await runDex(ctx());
    expect(again.from).toBe(251n);
    expect(await prisma.dexTrade.count({ where: { pool: pool.pool } })).toBe(7); // 5 ok, the outlier and the dust trade again
  });

  it("publishes the pool's own price at the last session's close (its last ok trade before 20:00 ET)", async () => {
    const end = Date.UTC(2026, 10, 14, 1, 0, 0); // Friday Nov 13, 20:00 EST
    await prisma.dexTrade.createMany({
      data: [
        { pool: pool.pool, txHash: '0xclose1', logIndex: 0, block: 90n, at: new Date(end - 30 * 60_000), symbol: 'NVDA', price: '161.5', qty: '1', notional: '161.5', status: 'ok' },
        { pool: pool.pool, txHash: '0xclose2', logIndex: 0, block: 95n, at: new Date(end - 2 * 60_000), symbol: 'NVDA', price: '161.16', qty: '1', notional: '161.16', status: 'ok' },
        { pool: pool.pool, txHash: '0xclose3', logIndex: 0, block: 96n, at: new Date(end - 60_000), symbol: 'NVDA', price: '170', qty: '0.01', notional: '1.7', status: 'dust' },
      ],
    });
    store.clear();
    const c = ctx();
    c.liquidity.set(pool.pool, { usdgSide: 400_000n * 10n ** 18n, tokenSideUsdg: 1_400_000n * 10n ** 18n, at: T });
    await publishSnapshots(c, T + 3_600_000);
    const snap = openJson<Record<string, unknown>>(store.get(DEX_CACHE_KEY('NVDA')), DEX_CACHE_KEY('NVDA'), mainnetTestMac);
    expect(snap?.close).toEqual({ end, price: '161.16', at: end - 2 * 60_000 });
    await prisma.dexTrade.deleteMany({ where: { txHash: { in: ['0xclose1', '0xclose2', '0xclose3'] } } });
  });

  it('flags a pool under the liquidity threshold', async () => {
    const thin: DexRpc = { ...rpc, call: async () => '0x' + (1000n * 10n ** 6n).toString(16) };
    store.clear();
    await runDex({ ...ctx(), rpc: thin, liquidity: new Map() });
    const snap = openJson<Record<string, unknown>>(store.get(DEX_CACHE_KEY('NVDA')), DEX_CACHE_KEY('NVDA'), mainnetTestMac);
    expect(snap?.belowThreshold).toBe(true);
  });
});
