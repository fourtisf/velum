/** Regression tests for the November 2026 internal audit (backend L7, L9, L14). */
import { CHAIN, PROTOCOL, TIMEFRAMES, cacheKeys, type Timeframe } from '@velum/config';
import type { PrismaClient } from '@velum/db';
import { parseWad } from '@velum/math';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { seriesKey, type CandleJobData, type WorkerContext } from './context';
import { loadEnv } from './env';
import { CANDLE_JOB_OPTIONS, runCandles } from './jobs/candles';
import { bucketStart, candleUpsertSql, toCandle, type WadCandle } from './lib/candles';
import type { Logger } from './lib/log';
import { redactUrls } from './lib/redact';
import { FEED_MAX_FUTURE_S, checkFeedRound, chainlinkSource, type FeedClient, type FeedRound } from './sources';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const T0 = Date.UTC(2026, 10, 14, 10, 0, 0);

describe('L7: URLs with secrets are redacted everywhere', () => {
  it('strips keys, passwords, paths and queries from any scheme', () => {
    expect(redactUrls('x https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY123 y')).toBe('x https://robinhood-mainnet.g.alchemy.com/… y');
    expect(redactUrls('postgresql://velum:hunter2@127.0.0.1:5432/velum?schema=public')).toBe('postgresql://127.0.0.1:5432/…');
    expect(redactUrls('redis://:s3cr%40t@127.0.0.1:6379/5')).toBe('redis://127.0.0.1:6379/…');
  });
  it('keeps the provider key out of the wrong-network startup error', () => {
    const wrong = CHAIN.id === 46630 ? 'https://rpc.mainnet.chain.robinhood.com/SECRETKEY123' : 'https://rpc.testnet.chain.robinhood.com/SECRETKEY123';
    expect(() => loadEnv({ DATABASE_URL: 'postgresql://a', REDIS_URL: 'redis://b', RPC_URL: wrong })).toThrow(/other network/);
    try {
      loadEnv({ DATABASE_URL: 'postgresql://a', REDIS_URL: 'redis://b', RPC_URL: wrong });
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRETKEY123');
    }
  });
});

// ── L9: candles ───────────────────────────────────────────────────────────────

interface Fake {
  ctx: WorkerContext;
  sql: Array<{ sql: string; values: unknown[] }>;
  transactions: number;
  cache: Map<string, string>;
  failDb: { next: number };
}

function fakeCtx(): Fake {
  const sql: Fake['sql'] = [];
  const cache = new Map<string, string>();
  const failDb = { next: 0 };
  const state = { transactions: 0 };
  const exec = async (q: { sql: string; values: unknown[] }) => {
    if (failDb.next > 0) {
      failDb.next--;
      throw new Error('connection reset');
    }
    sql.push({ sql: q.sql, values: q.values });
    return 1;
  };
  const prisma = {
    $executeRaw: (q: { sql: string; values: unknown[] }) => ({ q, then: (res: (v: number) => unknown, rej: (e: unknown) => unknown) => exec(q).then(res, rej) }),
    $transaction: async (ops: Array<{ q: { sql: string; values: unknown[] } }>) => {
      if (failDb.next > 0) {
        failDb.next--;
        throw new Error('connection reset');
      }
      state.transactions++;
      for (const op of ops) sql.push({ sql: op.q.sql, values: op.q.values });
      return ops.map(() => 1);
    },
  } as unknown as PrismaClient;
  const redis = {
    pipeline() {
      const ops: Array<[string, string]> = [];
      return {
        set(k: string, v: string) {
          ops.push([k, v]);
          return this;
        },
        async exec() {
          for (const [k, v] of ops) cache.set(k, v);
          return [];
        },
      };
    },
    async set(k: string, v: string) {
      cache.set(k, v);
      return 'OK';
    },
  } as unknown as Redis;
  const ctx = {
    env: {} as WorkerContext['env'],
    prisma,
    redis,
    log: silent,
    source: { name: 'demo', read: async () => new Map() },
    marketIds: new Map([['TSLA', 'm-tsla']]),
    snapshots: new Map(),
    open24h: new Map(),
    lastOpenRefresh: 0,
    series: new Map<string, WadCandle[]>(),
    lastTickAt: new Map<string, number>(),
    enqueueCandles: async () => {},
  } as WorkerContext;
  return {
    ctx,
    sql,
    get transactions() {
      return state.transactions;
    },
    cache,
    failDb,
  };
}

const tick = (at: number, price: string): CandleJobData => ({ at, prices: { TSLA: price } });
const cached = (f: Fake, tf: Timeframe) => JSON.parse(f.cache.get(cacheKeys.candles('TSLA', tf)) ?? 'null');
const snapshot = (ctx: WorkerContext) => JSON.stringify([...ctx.series].map(([k, s]) => [k, s.map(toCandle)]));

describe('L9: candle cache follows Postgres, failed jobs are retried', () => {
  it('retries candle jobs with backoff', () => {
    expect(CANDLE_JOB_OPTIONS.attempts).toBeGreaterThanOrEqual(3);
    expect(CANDLE_JOB_OPTIONS.backoff.type).toBe('exponential');
  });

  it('leaves memory and the Redis cache untouched when the database write fails, then commits on retry', async () => {
    const f = fakeCtx();
    await runCandles(f.ctx, tick(T0 + 1000, '100'));
    const before = snapshot(f.ctx);
    const cacheBefore = new Map(f.cache);

    f.failDb.next = 1;
    await expect(runCandles(f.ctx, tick(T0 + 3000, '120'))).rejects.toThrow('connection reset');
    expect(snapshot(f.ctx)).toBe(before);
    expect([...f.cache].filter(([k]) => !k.includes('heartbeat'))).toEqual([...cacheBefore].filter(([k]) => !k.includes('heartbeat')));
    expect(f.ctx.lastTickAt.get('TSLA')).toBe(T0 + 1000);

    // BullMQ retries the same job: now it lands everywhere.
    expect(await runCandles(f.ctx, tick(T0 + 3000, '120'))).toBe(TIMEFRAMES.length);
    for (const tf of TIMEFRAMES) expect(cached(f, tf).at(-1)).toEqual({ t: bucketStart(T0, tf), o: '100', h: '120', l: '100', c: '120' });
    expect(f.ctx.lastTickAt.get('TSLA')).toBe(T0 + 3000);
  });

  it('a late retry extends high/low but never moves the close back', async () => {
    const f = fakeCtx();
    await runCandles(f.ctx, tick(T0 + 1000, '100'));
    f.failDb.next = 1;
    await expect(runCandles(f.ctx, tick(T0 + 3000, '90'))).rejects.toThrow();
    await runCandles(f.ctx, tick(T0 + 5000, '105')); // newer tick succeeds first
    f.sql.length = 0;
    await runCandles(f.ctx, tick(T0 + 3000, '90')); // backoff retry of the older tick
    expect(f.sql).toHaveLength(1);
    expect(f.sql[0]!.sql).toContain('"c" = "Candle"."c"');
    expect(f.sql[0]!.sql).not.toContain('EXCLUDED."c"');
    for (const tf of TIMEFRAMES) expect(cached(f, tf).at(-1)).toEqual({ t: bucketStart(T0, tf), o: '100', h: '105', l: '90', c: '105' });
    expect(f.ctx.lastTickAt.get('TSLA')).toBe(T0 + 5000);
    // A late tick that changes nothing writes nothing.
    f.sql.length = 0;
    expect(await runCandles(f.ctx, tick(T0 + 4000, '100'))).toBe(0);
    expect(f.sql).toHaveLength(0);
  });

  it('writes fresh and late markets of one job in a single transaction', async () => {
    const f = fakeCtx();
    f.ctx.marketIds.set('AMZN', 'm-amzn');
    await runCandles(f.ctx, { at: T0 + 5000, prices: { TSLA: '100' } });
    await runCandles(f.ctx, { at: T0 + 3000, prices: { TSLA: '80', AMZN: '200' } });
    expect(f.transactions).toBe(1);
    expect(f.sql.at(-2)!.sql).toContain('EXCLUDED."c"');
    expect(f.sql.at(-1)!.sql).toContain('"Candle"."c"');
    expect(f.ctx.series.get(seriesKey('AMZN', '1h'))!.map(toCandle)).toEqual([{ t: T0, o: '200', h: '200', l: '200', c: '200' }]);
  });

  // Needs TEST_DATABASE_URL pointing at a migrated database. Skipped otherwise.
  it.skipIf(!process.env.TEST_DATABASE_URL)('keepClose upsert keeps the close on Postgres', async () => {
    const { PrismaClient: Client } = await import('@velum/db');
    const prisma = new Client({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
    try {
      const m = await prisma.market.upsert({ where: { symbol: 'ZZC' }, create: { symbol: 'ZZC', name: 'ZZC', status: 'live', maxLeverage: 5, takerFeeBps: 6 }, update: {}, select: { id: true } });
      await prisma.candle.deleteMany({ where: { marketId: m.id } });
      const row = (price: string) => ({ marketId: m.id, tf: '1h' as const, t: T0, price });
      await prisma.$executeRaw(candleUpsertSql([row('100')], { source: 'robinhood' }));
      await prisma.$executeRaw(candleUpsertSql([row('105')], { source: 'robinhood' }));
      await prisma.$executeRaw(candleUpsertSql([row('90')], { source: 'robinhood', keepClose: true }));
      const c = await prisma.candle.findFirstOrThrow({ where: { marketId: m.id } });
      expect([c.o, c.h, c.l, c.c].map((d) => d.toFixed())).toEqual(['100', '105', '90', '105']);
      await prisma.candle.deleteMany({ where: { marketId: m.id } });
      await prisma.market.delete({ where: { id: m.id } });
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ── L14: chainlink path ───────────────────────────────────────────────────────

describe('L14: chainlink rounds are bounds- and time-checked', () => {
  const now = T0;
  const nowS = BigInt(Math.floor(now / 1000));
  const round = (over: Partial<FeedRound> = {}): FeedRound => ({ roundId: 5n, answer: 39_165_000_000n, updatedAt: nowS - 10n, answeredInRound: 5n, ...over });

  it('accepts a fresh, positive, in-bounds answer', () => {
    expect(checkFeedRound(round(), 8, now)).toEqual({ ok: true, price: '391.65' });
    expect(checkFeedRound(round({ updatedAt: nowS + BigInt(FEED_MAX_FUTURE_S) }), 8, now).ok).toBe(true);
  });
  it('rejects future, missing and stale timestamps', () => {
    expect(checkFeedRound(round({ updatedAt: nowS + BigInt(FEED_MAX_FUTURE_S) + 1n }), 8, now)).toMatchObject({ ok: false, reason: 'future' });
    expect(checkFeedRound(round({ updatedAt: nowS + 86_400n * 365n }), 8, now)).toMatchObject({ ok: false, reason: 'future' });
    expect(checkFeedRound(round({ updatedAt: 0n }), 8, now)).toMatchObject({ ok: false, reason: 'no-timestamp' });
    expect(checkFeedRound(round({ updatedAt: nowS - BigInt(PROTOCOL.oracleMaxAgeSeconds) - 1n }), 8, now)).toMatchObject({ ok: false, reason: 'stale' });
  });
  it('rejects non-positive, absurd and dust answers, odd decimals and incomplete rounds', () => {
    expect(checkFeedRound(round({ answer: 0n }), 8, now)).toMatchObject({ reason: 'answer' });
    expect(checkFeedRound(round({ answer: -1n }), 8, now)).toMatchObject({ reason: 'answer' });
    expect(checkFeedRound(round({ answer: 10n ** 17n }), 8, now)).toMatchObject({ reason: 'bounds' }); // 1e9 USDG
    expect(checkFeedRound(round({ answer: 2n ** 255n - 1n }), 8, now)).toMatchObject({ reason: 'bounds' });
    expect(checkFeedRound(round({ answer: 1n }), 8, now)).toMatchObject({ reason: 'bounds' }); // rounds to 0
    expect(checkFeedRound(round(), 77, now)).toMatchObject({ reason: 'decimals' });
    expect(checkFeedRound(round({ answeredInRound: 4n }), 8, now)).toMatchObject({ reason: 'incomplete-round' });
  });
  it('the source skips rejected feeds and keeps good ones', async () => {
    const answers: Record<string, readonly [bigint, bigint, bigint, bigint, bigint]> = {
      '0x0000000000000000000000000000000000000001': [1n, 39_165_000_000n, 0n, nowS - 5n, 1n],
      '0x0000000000000000000000000000000000000002': [1n, 23_340_000_000n, 0n, nowS + 3600n, 1n],
      '0x0000000000000000000000000000000000000003': [1n, 10n ** 30n, 0n, nowS - 5n, 1n],
    };
    const client = {
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => (functionName === 'decimals' ? 8 : answers[address]),
    } as unknown as FeedClient;
    const warns: string[] = [];
    const log: Logger = { ...silent, warn: (m, d) => warns.push(`${m}:${String(d?.reason)}`) };
    const src = chainlinkSource('https://rpc.example', { TSLA: '0x0000000000000000000000000000000000000001', AMZN: '0x0000000000000000000000000000000000000002', PLTR: '0x0000000000000000000000000000000000000003' }, log, client);
    const out = await src.read(new Map(), now);
    expect([...out]).toEqual([['TSLA', '391.65']]);
    expect(warns.sort()).toEqual(['feed round rejected:bounds', 'feed round rejected:future']);
    expect(parseWad(out.get('TSLA')!)).toBeGreaterThan(0n);
  });
});
