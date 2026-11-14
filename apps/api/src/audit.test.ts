/** Regression tests for the November 2026 internal audit (backend L2, L6, L7, MARKET_CLOSED copy). */
import { CHAIN, type MarketSnapshot } from '@velum/config';
import type { PrismaClient } from '@velum/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadEnv, type ApiEnv } from './env';
import { MAX_POOLS, prismaDb, publishedPoolsSql } from './lib/adapters';
import type { AppDeps } from './lib/deps';
import { redactUrls } from './lib/redact';
import { marketClosedMessage } from './routes/quote';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const env: ApiEnv = {
  host: '127.0.0.1',
  port: 0,
  databaseUrl: 'postgresql://x',
  redisUrl: 'redis://x',
  corsOrigins: false,
  rateReadPerMin: 120,
  rateQuotePerMin: 30,
  rateHealthPerMin: 60,
  rpcUrl: 'http://localhost:1',
  chainId: 46630,
  demoMode: true,
  logLevel: 'silent',
  proxySecret: null,
};
const snap = (symbol: string, price: string): MarketSnapshot => ({ symbol, price, mark: price, open24h: price, spark: [price], source: 'demo', updatedAt: NOW - 1000 });

let app: FastifyInstance | undefined;
async function make(envOver: Partial<ApiEnv> = {}, over: Partial<AppDeps> = {}) {
  app = await buildApp({
    env: { ...env, ...envOver },
    cache: {
      ping: async () => true,
      snapshots: async (syms) => new Map(syms.filter((s) => s === 'TSLA').map((s) => [s, snap(s, '391.65')])),
      candles: async () => null,
      heartbeat: async () => NOW - 1000,
    },
    db: { ping: async () => true, candles: async () => [], publishedPools: async () => [] },
    chain: { blockNumber: async () => 1n },
    now: () => NOW,
    ...over,
  });
  return app;
}
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('L6: /v1/health is rate limited', () => {
  it('answers 429 in the error format once the per-IP health budget is spent', async () => {
    const a = await make({ rateHealthPerMin: 2 });
    expect((await a.inject('/v1/health')).statusCode).toBe(200);
    expect((await a.inject('/v1/health')).statusCode).toBe(200);
    const res = await a.inject('/v1/health');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    // Other clients keep their own budget.
    expect((await a.inject({ url: '/v1/health', remoteAddress: '10.0.0.9' })).statusCode).toBe(200);
  });
  it('uses its own budget, separate from reads', async () => {
    const a = await make({ rateHealthPerMin: 1, rateReadPerMin: 100 });
    expect((await a.inject('/v1/health')).statusCode).toBe(200);
    expect((await a.inject('/v1/health')).statusCode).toBe(429);
    expect((await a.inject('/v1/stats')).statusCode).toBe(200);
  });
  it('defaults to 60 per minute and validates the setting', () => {
    const base = { DATABASE_URL: 'postgresql://a', REDIS_URL: 'redis://b' };
    expect(loadEnv(base).rateHealthPerMin).toBe(60);
    expect(loadEnv({ ...base, RATE_LIMIT_HEALTH_PER_MIN: '5' }).rateHealthPerMin).toBe(5);
    expect(() => loadEnv({ ...base, RATE_LIMIT_HEALTH_PER_MIN: '0' })).toThrow(/RATE_LIMIT_HEALTH_PER_MIN/);
  });
});

describe('L7: startup errors never print secrets in URLs', () => {
  it('redacts API keys, passwords, paths and queries', () => {
    expect(redactUrls('see https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY123 now')).toBe('see https://robinhood-mainnet.g.alchemy.com/… now');
    expect(redactUrls('db postgresql://velum:hunter2@127.0.0.1:5432/velum?schema=public')).toBe('db postgresql://127.0.0.1:5432/…');
    expect(redactUrls('redis://:p%40ss@127.0.0.1:6379/5,')).toBe('redis://127.0.0.1:6379/…,');
    expect(redactUrls('(https://user:pw@rpc.example.com:8545/?key=abc)')).toBe('(https://rpc.example.com:8545/…)');
    expect(redactUrls('no urls here')).toBe('no urls here');
  });
  it('keeps the provider key out of the wrong-network message', () => {
    const wrong = CHAIN.id === 46630 ? 'https://rpc.mainnet.chain.robinhood.com/v2/SECRETKEY123' : 'https://rpc.testnet.chain.robinhood.com/v2/SECRETKEY123';
    let message = '';
    try {
      loadEnv({ DATABASE_URL: 'postgresql://a', REDIS_URL: 'redis://b', RPC_URL: wrong });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/RPC_URL points at the other network/);
    expect(message).not.toContain('SECRETKEY123');
  });
});

describe('MARKET_CLOSED names the configured network', () => {
  it('uses the network label, so mainnet never says "testnet"', () => {
    expect(marketClosedMessage('NVDA', 'Robinhood Chain')).toBe("NVDA isn't on Robinhood Chain yet.");
    expect(marketClosedMessage('NVDA', 'Robinhood Chain testnet')).toBe("NVDA isn't on Robinhood Chain testnet yet.");
  });
  it('is what the quote route returns', async () => {
    const a = await make();
    const res = await a.inject({ method: 'POST', url: '/v1/quote', payload: { from: 'USDG', to: 'NVDA', amount: '1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'MARKET_CLOSED', message: `NVDA isn't on ${CHAIN.label} yet.` } });
  });
});

describe('L2: published pools come from one bounded SQL query', () => {
  it('reads the latest published row per pool in SQL with a LIMIT, and maps rows', async () => {
    const calls: unknown[] = [];
    const decimal = (s: string) => ({ toFixed: () => s });
    const fake = {
      $queryRaw: async (q: unknown) => {
        calls.push(q);
        return [{ symbol: 'TSLA', feeBps: 30, sizeRounded: decimal('1234567.00'), aprEst: decimal('10.5000'), hour: new Date(NOW) }];
      },
      poolHourly: { findMany: async () => { throw new Error('must not load every row'); } },
    } as unknown as PrismaClient;
    expect(await prismaDb(fake).publishedPools()).toEqual([{ symbol: 'TSLA', feeBps: 30, sizeRounded: '1234567.00', aprEst: '10.5000', hour: NOW }]);
    expect(calls).toEqual([publishedPoolsSql]);
    const sql = publishedPoolsSql.sql.replace(/\s+/g, ' ');
    expect(sql).toContain('CROSS JOIN LATERAL');
    expect(sql).toContain('WHERE h."poolId" = p."id" AND h."published" = true ORDER BY h."hour" DESC LIMIT 1');
    expect(sql).toMatch(/LIMIT \?$|LIMIT \$\d+$/);
    expect(publishedPoolsSql.values).toEqual([MAX_POOLS]);
  });

  // Runs against a real Postgres when TEST_DATABASE_URL points at a migrated database
  // (pnpm --filter @velum/db exec prisma migrate deploy). Skipped otherwise.
  it.skipIf(!process.env.TEST_DATABASE_URL)('returns only the newest published hour per pool on Postgres', async () => {
    const { PrismaClient: Client } = await import('@velum/db');
    const prisma = new Client({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
    try {
      await prisma.poolHourly.deleteMany({});
      await prisma.pool.deleteMany({});
      await prisma.market.deleteMany({ where: { symbol: { in: ['ZZA', 'ZZB'] } } });
      const mk = async (symbol: string) => {
        const m = await prisma.market.create({ data: { symbol, name: symbol, status: 'live', maxLeverage: 5, takerFeeBps: 6 } });
        return prisma.pool.create({ data: { marketId: m.id, feeBps: 30 } });
      };
      const a = await mk('ZZA');
      const b = await mk('ZZB');
      const h = (n: number) => new Date(NOW - n * 3_600_000);
      const row = (poolId: string, hour: Date, size: string, published: boolean) => ({ poolId, hour, sizeRounded: size, aprEst: '1', fills: 0, makers: 0, published });
      await prisma.poolHourly.createMany({
        data: [row(a.id, h(3), '300', true), row(a.id, h(2), '200', true), row(a.id, h(1), '100', false), row(b.id, h(5), '50', true)],
      });
      const out = await prismaDb(prisma).publishedPools();
      expect(out).toEqual([
        { symbol: 'ZZA', feeBps: 30, sizeRounded: '200', aprEst: '1', hour: h(2).getTime() },
        { symbol: 'ZZB', feeBps: 30, sizeRounded: '50', aprEst: '1', hour: h(5).getTime() },
      ]);
    } finally {
      await prisma.poolHourly.deleteMany({});
      await prisma.pool.deleteMany({});
      await prisma.market.deleteMany({ where: { symbol: { in: ['ZZA', 'ZZB'] } } });
      await prisma.$disconnect();
    }
  });
});
