/**
 * Regression tests for audit R2-L1 (L9 incomplete): after a worker restart, a delayed BullMQ retry of
 * an older candle job must not move the close back. index.ts seeds lastTickAt from Postgres on start.
 */
import { TIMEFRAMES, cacheKeys } from '@velum/config';
import type { PrismaClient } from '@velum/db';
import { parseWad } from '@velum/math';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { openJson, testMac } from '../__fixtures__/mac';
import { loadLastTickAt } from '../bootstrap';
import { seriesKey, type CandleJobData, type WorkerContext } from '../context';
import { bucketStart, toCandle, type WadCandle } from '../lib/candles';
import type { Logger } from '../lib/log';
import { runCandles } from './candles';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const T0 = Date.UTC(2026, 10, 14, 10, 0, 0);
const p = (s: string) => parseWad(s)!;

/** What index.ts builds on start: series and lastTickAt both read back from Postgres (here: fakes). */
async function ctxAfterRestart(series: Map<string, WadCandle[]>, newestTick: Map<string, Date>) {
  const sql: string[] = [];
  const cache = new Map<string, string>();
  const prisma = {
    $executeRaw: (q: { sql: string }) => ({ then: (res: (v: number) => unknown) => (sql.push(q.sql), Promise.resolve(1).then(res)) }),
    $transaction: async (ops: unknown[]) => ops.map(() => 1),
    priceTick: {
      findFirst: async ({ where, orderBy }: { where: { marketId: string }; orderBy: { at: string } }) => {
        expect(orderBy).toEqual({ at: 'desc' });
        const at = newestTick.get(where.marketId);
        return at ? { at } : null;
      },
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
  const marketIds = new Map([
    ['TSLA', 'm-tsla'],
    ['AMZN', 'm-amzn'],
  ]);
  const ctx = {
    env: {} as WorkerContext['env'],
    prisma,
    redis,
    log: silent,
    source: { name: 'robinhood', read: async () => new Map() },
    marketIds,
    snapshots: new Map(),
    open24h: new Map(),
    lastOpenRefresh: 0,
    series,
    lastTickAt: await loadLastTickAt(prisma, marketIds),
    mac: testMac,
    enqueueCandles: async () => {},
  } as WorkerContext;
  return { ctx, sql, cache };
}

const storedSeries = () =>
  new Map<string, WadCandle[]>(TIMEFRAMES.map((tf) => [seriesKey('TSLA', tf), [{ t: bucketStart(T0, tf), o: p('100'), h: p('105'), l: p('100'), c: p('105') }]]));

describe('R2-L1: a retried candle job delivered after a restart never rewinds the close', () => {
  it('seeds lastTickAt from the newest stored tick per market', async () => {
    const { ctx } = await ctxAfterRestart(storedSeries(), new Map([['m-tsla', new Date(T0 + 5000)]]));
    expect([...ctx.lastTickAt]).toEqual([['TSLA', T0 + 5000]]);
  });

  it('an older retry only extends high/low, in Postgres, memory and the Redis cache', async () => {
    // Before the restart: tick @T0+3s (90) failed and waited for a backoff retry; tick @T0+5s (105) then
    // committed, so Postgres holds close = 105 and the newest PriceTick is @T0+5s. Then the worker restarted.
    const { ctx, sql, cache } = await ctxAfterRestart(storedSeries(), new Map([['m-tsla', new Date(T0 + 5000)]]));
    const retry: CandleJobData = { at: T0 + 3000, prices: { TSLA: '90' } };
    await runCandles(ctx, retry);

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('"c" = "Candle"."c"');
    expect(sql[0]).not.toContain('EXCLUDED."c"');
    for (const tf of TIMEFRAMES) {
      expect(ctx.series.get(seriesKey('TSLA', tf))!.map(toCandle).at(-1)).toEqual({ t: bucketStart(T0, tf), o: '100', h: '105', l: '90', c: '105' });
      const k = cacheKeys.candles('TSLA', tf);
      expect(openJson<{ source: string; candles: Array<{ c: string }> }>(cache.get(k), k)).toMatchObject({ source: 'robinhood', candles: [{ c: '105' }] });
    }
    expect(ctx.lastTickAt.get('TSLA')).toBe(T0 + 5000);
  });

  it('the newest stored tick itself and anything newer still move the close', async () => {
    const { ctx, sql } = await ctxAfterRestart(storedSeries(), new Map([['m-tsla', new Date(T0 + 5000)]]));
    await runCandles(ctx, { at: T0 + 5000, prices: { TSLA: '104' } });
    expect(sql.at(-1)).toContain('EXCLUDED."c"');
    await runCandles(ctx, { at: T0 + 7000, prices: { TSLA: '106' } });
    for (const tf of TIMEFRAMES) expect(ctx.series.get(seriesKey('TSLA', tf))!.map(toCandle).at(-1)!.c).toBe('106');
    expect(ctx.lastTickAt.get('TSLA')).toBe(T0 + 7000);
  });

  it('a market with no stored ticks starts empty (first tick applies normally)', async () => {
    const { ctx } = await ctxAfterRestart(new Map(), new Map());
    expect(ctx.lastTickAt.size).toBe(0);
    await runCandles(ctx, { at: T0, prices: { AMZN: '200' } });
    expect(ctx.series.get(seriesKey('AMZN', '1h'))!.map(toCandle)).toEqual([{ t: T0, o: '200', h: '200', l: '200', c: '200' }]);
  });

  // Needs TEST_DATABASE_URL pointing at a migrated database. Skipped otherwise.
  it.skipIf(!process.env.TEST_DATABASE_URL)('loadLastTickAt reads the newest tick per market on Postgres', async () => {
    const { PrismaClient: Client } = await import('@velum/db');
    const prisma = new Client({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
    const symbols = ['ZZL1', 'ZZL2', 'ZZL3'];
    const cleanup = async () => {
      const ms = await prisma.market.findMany({ where: { symbol: { in: symbols } }, select: { id: true } });
      await prisma.priceTick.deleteMany({ where: { marketId: { in: ms.map((m) => m.id) } } });
      await prisma.market.deleteMany({ where: { symbol: { in: symbols } } });
    };
    try {
      await cleanup();
      const ids = new Map<string, string>();
      for (const s of symbols) ids.set(s, (await prisma.market.create({ data: { symbol: s, name: s, status: 'live', maxLeverage: 5, takerFeeBps: 6 } })).id);
      const tick = (s: string, ms: number) => ({ marketId: ids.get(s)!, price: '1', source: 'robinhood', at: new Date(T0 + ms) });
      await prisma.priceTick.createMany({ data: [tick('ZZL1', 1000), tick('ZZL1', 5000), tick('ZZL1', 3000), tick('ZZL2', 2000)] });
      expect([...(await loadLastTickAt(prisma, ids))].sort()).toEqual([
        ['ZZL1', T0 + 5000],
        ['ZZL2', T0 + 2000],
      ]);
    } finally {
      await cleanup();
      await prisma.$disconnect();
    }
  });
});
