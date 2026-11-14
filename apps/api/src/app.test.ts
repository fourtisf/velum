import { MARKETS, type Candle, type MarketSnapshot } from '@velum/config';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import type { ApiEnv } from './env';
import { loadEnv } from './env';
import type { AppDeps, CacheReader, DbReader } from './lib/deps';
import { demoProofsToday } from './routes/stats';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

const env: ApiEnv = {
  host: '127.0.0.1',
  port: 0,
  databaseUrl: 'postgresql://x',
  redisUrl: 'redis://x',
  corsOrigins: false,
  rateReadPerMin: 120,
  rateQuotePerMin: 30,
  rpcUrl: 'http://localhost:1',
  chainId: 46630,
  demoMode: true,
  logLevel: 'silent',
};

const snap = (symbol: string, price: string, over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  symbol,
  price,
  mark: price,
  open24h: price,
  spark: [price],
  source: 'demo',
  updatedAt: NOW - 1000,
  ...over,
});

function fakeCache(snaps: MarketSnapshot[], candles: Record<string, Candle[]> = {}, up = true): CacheReader {
  const map = new Map(snaps.map((s) => [s.symbol, s]));
  return {
    ping: async () => up,
    snapshots: async (syms) => new Map(syms.filter((s) => map.has(s)).map((s) => [s, map.get(s)!])),
    candles: async (sym, tf) => candles[`${sym}:${tf}`] ?? null,
    heartbeat: async () => NOW - 3000,
  };
}

const fakeDb = (over: Partial<DbReader> = {}): DbReader => ({
  ping: async () => true,
  candles: async () => [],
  publishedPools: async () => [],
  ...over,
});

let app: FastifyInstance | undefined;
async function make(over: Partial<AppDeps> = {}, envOver: Partial<ApiEnv> = {}) {
  app = await buildApp({
    env: { ...env, ...envOver },
    cache: fakeCache([snap('TSLA', '391.65', { open24h: '386.20', mark: '391.81' }), snap('AMZN', '233.40'), snap('NVDA', '186.40')]),
    db: fakeDb(),
    chain: { blockNumber: async () => 153118480n },
    now: () => NOW,
    ...over,
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('health', () => {
  it('reports chain, block and lag', async () => {
    const res = await (await make()).inject('/v1/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, chainId: 46630, block: 153118480, lag: 3, db: true, redis: true, demoMode: true });
  });
  it('stays healthy when the RPC is down, fails when Redis is down', async () => {
    const a = await make({ chain: { blockNumber: async () => null } });
    expect((await a.inject('/v1/health')).json()).toMatchObject({ ok: true, block: null });
    await a.close();
    const b = await make({ cache: fakeCache([], {}, false) });
    const res = await b.inject('/v1/health');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, redis: false, lag: null });
  });
});

describe('markets', () => {
  it('lists all markets with string money and status', async () => {
    const res = await (await make()).inject('/v1/markets');
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(MARKETS.length);
    const tsla = body.find((m) => m.symbol === 'TSLA')!;
    expect(tsla).toMatchObject({
      name: 'Tesla',
      status: 'live',
      token: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E',
      price: '391.65',
      mark: '391.81',
      open24h: '386.2',
      change24h: '1.41',
      fundingPerHour: '0.0042',
      openInterest: '742000',
      maxLeverage: 5,
      takerFeeBps: 6,
      maintenanceMargin: '0.10',
      stale: false,
    });
    expect(body.find((m) => m.symbol === 'NVDA')).toMatchObject({ status: 'coming_soon', token: null });
  });
  it('falls back to the seed price and flags stale when a snapshot is missing or old', async () => {
    const a = await make({ cache: fakeCache([snap('AMZN', '230.00', { updatedAt: NOW - 120_000 })]) });
    const body = (await a.inject('/v1/markets')).json() as Array<Record<string, unknown>>;
    expect(body.find((m) => m.symbol === 'TSLA')).toMatchObject({ price: '391.65', stale: true, change24h: '0.00', spark: ['391.65'] });
    expect(body.find((m) => m.symbol === 'AMZN')).toMatchObject({ price: '230.00', stale: true });
  });
  it('returns one market and 404s unknown ones', async () => {
    const a = await make();
    expect((await a.inject('/v1/markets/tsla')).json()).toMatchObject({ symbol: 'TSLA' });
    const res = await a.inject('/v1/markets/XYZ');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'No market called XYZ.' } });
  });
});

describe('candles', () => {
  const c = (t: number): Candle => ({ t, o: '1', h: '2', l: '0.5', c: '1.5' });
  it('serves the cache, trimmed to limit', async () => {
    const list = Array.from({ length: 10 }, (_, i) => c(i));
    const a = await make({ cache: fakeCache([], { 'TSLA:4h': list }) });
    const res = await a.inject('/v1/markets/TSLA/candles?tf=4h&limit=3');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(list.slice(-3));
  });
  it('falls back to the database', async () => {
    const a = await make({ db: fakeDb({ candles: async (_s, tf, limit) => (tf === '1h' && limit === 120 ? [c(42)] : []) }) });
    expect((await a.inject('/v1/markets/TSLA/candles')).json()).toEqual([c(42)]);
  });
  it('rejects bad tf and limit', async () => {
    const a = await make();
    for (const q of ['tf=2h', 'limit=0', 'limit=301', 'limit=abc']) {
      const res = await a.inject(`/v1/markets/TSLA/candles?${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    }
    expect((await a.inject('/v1/markets/NOPE/candles')).statusCode).toBe(404);
  });
});

describe('pools and stats', () => {
  it('rounds pool sizes to 2 significant figures', async () => {
    const body = (await (await make()).inject('/v1/pools')).json() as Array<Record<string, unknown>>;
    expect(body[0]).toEqual({
      symbol: 'TSLA',
      pair: 'TSLA/USDG',
      feeBps: 30,
      sizeRounded: '1200000',
      aprEst: '14.2',
      updatedHour: NOW,
      status: 'live',
    });
    expect(body.find((p) => p.symbol === 'NVDA')).toMatchObject({ status: 'coming_soon', sizeRounded: '1500000' });
  });
  it('prefers published hourly rows', async () => {
    const a = await make({
      db: fakeDb({ publishedPools: async () => [{ symbol: 'TSLA', feeBps: 30, sizeRounded: '1234567', aprEst: '10.5', hour: 1 }] }),
    });
    const body = (await a.inject('/v1/pools')).json() as Array<Record<string, unknown>>;
    expect(body[0]).toMatchObject({ sizeRounded: '1200000', aprEst: '10.5', updatedHour: 1 });
  });
  it('returns stats', async () => {
    const res = (await (await make()).inject('/v1/stats')).json();
    expect(res).toEqual({ markets: 10, openInterest: '4977000', shieldedValue: '4800000', proofsToday: demoProofsToday(NOW) });
    expect(demoProofsToday(NOW)).toBeGreaterThan(8000);
    expect(demoProofsToday(NOW + 60_000)).toBeGreaterThanOrEqual(demoProofsToday(NOW));
  });
});

describe('quote', () => {
  const post = async (a: FastifyInstance, payload: unknown) => a.inject({ method: 'POST', url: '/v1/quote', payload: payload as object });

  it('quotes USDG -> TSLA rounded down to 4 significant figures', async () => {
    const res = await post(await make(), { from: 'USDG', to: 'TSLA', amount: '1000' });
    expect(res.statusCode).toBe(200);
    // 1000 / 391.65 * 0.997 * (1 - 0.0008) = 2.54355... ; min = out * 0.995
    expect(res.json()).toEqual({ out: '2.543', min: '2.53', hops: 1, route: ['USDG', 'TSLA'], feeUsd: '3.00', rate: '0.002553', roundedTo: 4 });
  });
  it('routes stock to stock through USDG', async () => {
    const res = await post(await make(), { from: 'tsla', to: 'AMZN', amount: '2' });
    const body = res.json();
    expect(body.hops).toBe(2);
    expect(body.route).toEqual(['TSLA', 'USDG', 'AMZN']);
    const expected = ((2 * 391.65) / 233.4) * 0.997 ** 2 * (1 - 0.0016);
    expect(Math.abs(Number(body.out) - expected)).toBeLessThan(0.001);
    expect(body.out.replace('.', '').replace(/^0+/, '').length).toBeLessThanOrEqual(4);
  });
  it('validates input with the error format', async () => {
    const a = await make();
    const cases: Array<[unknown, number, string]> = [
      [{ from: 'USDG', to: 'TSLA' }, 400, 'BAD_REQUEST'],
      [{ from: 'USDG', to: 'TSLA', amount: '-1' }, 400, 'BAD_REQUEST'],
      [{ from: 'USDG', to: 'TSLA', amount: '0' }, 400, 'BAD_REQUEST'],
      [{ from: 'USDG', to: 'TSLA', amount: '1e9' }, 400, 'BAD_REQUEST'],
      [{ from: 'USDG', to: 'TSLA', amount: '1', extra: true }, 400, 'BAD_REQUEST'],
      [{ from: 'USDG', to: 'USDG', amount: '1' }, 400, 'BAD_REQUEST'],
      [{ from: 'DOGE', to: 'TSLA', amount: '1' }, 400, 'BAD_REQUEST'],
      [{ from: 'USDG', to: 'NVDA', amount: '1' }, 400, 'MARKET_CLOSED'],
    ];
    for (const [payload, status, code] of cases) {
      const res = await post(a, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(status);
      expect(res.json().error.code, JSON.stringify(payload)).toBe(code);
      expect(typeof res.json().error.message).toBe('string');
    }
    const junk = await a.inject({ method: 'POST', url: '/v1/quote', payload: '{nope', headers: { 'content-type': 'application/json' } });
    expect(junk.statusCode).toBe(400);
    expect(junk.json().error.code).toBe('BAD_REQUEST');
  });
  it('refuses stale prices', async () => {
    const a = await make({ cache: fakeCache([snap('TSLA', '391.65', { updatedAt: NOW - 61_000 })]) });
    const res = await post(a, { from: 'USDG', to: 'TSLA', amount: '10' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('STALE_PRICE');
    expect((await post(a, { from: 'USDG', to: 'AMZN', amount: '10' })).json().error.code).toBe('STALE_PRICE');
  });
});

describe('errors and limits', () => {
  it('404s unknown routes in the error format', async () => {
    const res = await (await make()).inject('/v1/nope?x=1');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'No route for GET /v1/nope.' } });
  });
  it('rate limits reads and quotes separately', async () => {
    const a = await make({}, { rateReadPerMin: 2, rateQuotePerMin: 1 });
    expect((await a.inject('/v1/stats')).statusCode).toBe(200);
    expect((await a.inject('/v1/stats')).statusCode).toBe(200);
    const res = await a.inject('/v1/stats');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect((await a.inject('/v1/health')).statusCode).toBe(200);
    const q = { method: 'POST' as const, url: '/v1/quote', payload: { from: 'USDG', to: 'TSLA', amount: '1' } };
    expect((await a.inject(q)).statusCode).toBe(200);
    expect((await a.inject(q)).json().error.code).toBe('RATE_LIMITED');
  });
});

describe('env', () => {
  const base = { DATABASE_URL: 'postgresql://a', REDIS_URL: 'redis://b' };
  it('applies defaults', () => {
    expect(loadEnv(base)).toMatchObject({ host: '127.0.0.1', port: 4000, chainId: 46630, rateReadPerMin: 120, rateQuotePerMin: 30, demoMode: true, corsOrigins: false });
    expect(loadEnv({ ...base, RPC_URL: 'VERIFY_FROM_OFFICIAL_DOCS' }).rpcUrl).toBe('https://rpc.testnet.chain.robinhood.com');
    expect(loadEnv({ ...base, CORS_ORIGIN: 'https://a.example, http://localhost:3000' }).corsOrigins).toEqual(['https://a.example', 'http://localhost:3000']);
  });
  it('lists every problem and refuses mainnet', () => {
    expect(() => loadEnv({ CHAIN_ID: '4663', PORT_API: 'x' })).toThrow(/DATABASE_URL[\s\S]*REDIS_URL[\s\S]*CHAIN_ID 4663[\s\S]*PORT_API/);
  });
});
