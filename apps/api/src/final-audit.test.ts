/**
 * Regression tests for the final backend audit (2026-11-15, API side): F-2 authenticated Redis values,
 * F-3 candle cache source on mainnet, F-4 unknown candles never real, F-6 unconfirmed quotes, F-7 HEAD
 * and OPTIONS rate limits. The auditor's probes (api-final-probe.test.ts) are A1, A2, B1 and B2 below.
 *
 * Optional: TEST_REDIS_URL=redis://:PASSWORD@127.0.0.1:PORT/DB (a scratch Redis; the tests delete only
 * the keys they write) runs the Redis-backed variants; TEST_DATABASE_URL (a migrated scratch database)
 * runs the Postgres one. Both are skipped without them.
 */
import { QUOTE_FROZEN_AFTER_MS, cacheKeys, parseRedisUrl, type Candle, type MarketSnapshot } from '@velum/config';
import { CACHE_MAC_PREFIX, createCacheMac, deriveCacheMacKey } from '@velum/config/src/cache-mac';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL_FOR_MAC, mainnetTestMac, sealedCandles, sealedHeartbeat, sealedSnapshot, testMac } from './__fixtures__/mac';
import { buildApp } from './app';
import type { ApiEnv } from './env';
import { prismaDb, redisCache } from './lib/adapters';
import type { AppDeps, DbReader } from './lib/deps';
import { priceState } from './lib/market-view';

// Monday 2026-11-16 15:00 UTC = 10:00 ET: the session is open. Sunday: closed.
const OPEN = Date.UTC(2026, 10, 16, 15, 0, 0);
const SUNDAY = Date.UTC(2026, 10, 15, 12, 0, 0);

const env: ApiEnv = {
  host: '127.0.0.1',
  port: 0,
  databaseUrl: TEST_DATABASE_URL_FOR_MAC,
  redisUrl: 'redis://x',
  redis: { db: 0 },
  corsOrigins: ['https://velum.example'],
  rateReadPerMin: 120,
  rateQuotePerMin: 30,
  rateHealthPerMin: 60,
  rateMarketsPerMin: 600,
  rpcUrl: 'http://localhost:1',
  chainId: 46630,
  network: 'testnet',
  demoMode: true,
  logLevel: 'silent',
  proxySecret: null,
  socketPath: null,
};

const snap = (symbol: string, over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  symbol,
  price: '391.65',
  mark: '391.8',
  open24h: '390',
  spark: ['391.65'],
  source: 'robinhood',
  updatedAt: OPEN - 1000,
  checkedAt: OPEN - 500,
  ...over,
});

function fakeRedis(store: Map<string, string>) {
  return {
    ping: async () => 'PONG',
    mget: async (...keys: string[]) => keys.map((k) => store.get(k) ?? null),
    get: async (k: string) => store.get(k) ?? null,
  } as unknown as Redis;
}

const dbOf = (over: Partial<DbReader> = {}): DbReader => ({ ping: async () => true, candles: async () => [], publishedPools: async () => [], ...over });

let app: FastifyInstance | undefined;
async function make(store: Map<string, string>, envOver: Partial<ApiEnv> = {}, over: Partial<AppDeps> = {}, now = OPEN) {
  const network = envOver.network ?? env.network;
  const mac = network === 'mainnet' ? mainnetTestMac : testMac;
  app = await buildApp({ env: { ...env, ...envOver }, cache: redisCache(fakeRedis(store), { mac, now: () => now }), db: dbOf(), chain: { blockNumber: async () => 1n }, now: () => now, ...over });
  return app;
}
afterEach(async () => {
  await app?.close();
  app = undefined;
});

// ── F-2: the MAC itself ───────────────────────────────────────────────────────

describe('F-2: cached values are authenticated with a key derived from DATABASE_URL', () => {
  const key = cacheKeys.price('TSLA');
  it('round-trips, and binds the Redis key, the network and the DATABASE_URL', () => {
    const v = testMac.seal(key, '{"a":1}');
    expect(v.startsWith(CACHE_MAC_PREFIX)).toBe(true);
    expect(testMac.open(key, v)).toBe('{"a":1}');
    expect(testMac.open(cacheKeys.price('AMZN'), v)).toBeNull();
    expect(mainnetTestMac.open(key, v)).toBeNull();
    expect(createCacheMac('postgresql://velum:rotated@127.0.0.1:5432/velum', 'testnet').open(key, v)).toBeNull();
  });
  it('treats unauthenticated, tampered, truncated, oversized and non-string values as missing', () => {
    const v = testMac.seal(key, '{"price":"391.65"}');
    for (const bad of [null, undefined, 42, '', '{"price":"391.65"}', v.replace('391.65', '0.01'), v.slice(0, -1), v.slice(0, 20), `${CACHE_MAC_PREFIX}${'A'.repeat(43)}.{}`, `${v}x`]) {
      expect(testMac.open(key, bad), String(bad)).toBeNull();
    }
    const big = testMac.seal(key, 'x'.repeat(10_000));
    expect(testMac.open(key, big)).toHaveLength(10_000);
    expect(testMac.open(key, big, 8 * 1024)).toBeNull();
  });
  it('the key is neither the URL nor the password, and an empty DATABASE_URL is refused', () => {
    const k = deriveCacheMacKey(TEST_DATABASE_URL_FOR_MAC);
    expect(k).toHaveLength(32);
    expect(k.toString('utf8')).not.toContain('test-only');
    expect(deriveCacheMacKey(` ${TEST_DATABASE_URL_FOR_MAC}\n`).equals(k)).toBe(true);
    expect(() => deriveCacheMacKey('')).toThrow(/DATABASE_URL/);
  });
});

// ── F-2: the auditor's probe B2 ───────────────────────────────────────────────

describe('F-2 (B2): a well-formed forged snapshot on a shared Redis is never served as live or quoted', () => {
  const forged = snap('TSLA', { price: '0.01', mark: '0.01', open24h: '0.01', spark: ['0.01'], updatedAt: OPEN, checkedAt: OPEN });
  it('without a MAC (the co-tenant knows only the Redis password): noPrice, quote 503', async () => {
    const a = await make(new Map([[cacheKeys.price('TSLA'), JSON.stringify(forged)]]), { network: 'mainnet', chainId: 4663 });
    expect((await a.inject('/v1/markets/TSLA')).json()).toMatchObject({ price: '391.65', stale: true, staleReason: 'noPrice', source: null });
    const q = await a.inject({ method: 'POST', url: '/v1/quote', payload: { from: 'USDG', to: 'TSLA', amount: '1000' } });
    expect(q.statusCode).toBe(503);
  });
  it('a genuine snapshot moved to another key, or written for testnet, is refused as well', async () => {
    const amzn = testMac.seal(cacheKeys.price('AMZN'), JSON.stringify(snap('TSLA')));
    const a = await make(new Map([[cacheKeys.price('TSLA'), amzn]]));
    expect((await a.inject('/v1/markets/TSLA')).json()).toMatchObject({ stale: true, staleReason: 'noPrice' });
    await app!.close();
    const b = await make(new Map([sealedSnapshot(forged, testMac)]), { network: 'mainnet', chainId: 4663 });
    expect((await b.inject('/v1/markets/TSLA')).json()).toMatchObject({ stale: true, staleReason: 'noPrice' });
  });
  it('a genuine snapshot is served live', async () => {
    const a = await make(new Map([sealedSnapshot(snap('TSLA', { price: '392.5' }), mainnetTestMac)]), { network: 'mainnet', chainId: 4663 });
    expect((await a.inject('/v1/markets/TSLA')).json()).toMatchObject({ price: '392.5', stale: false, source: 'robinhood' });
    expect((await a.inject({ method: 'POST', url: '/v1/quote', payload: { from: 'USDG', to: 'TSLA', amount: '1000' } })).statusCode).toBe(200);
  });
  it('a forged heartbeat cannot make dead workers look alive to deploy.sh', async () => {
    const forgedHb = new Map([[cacheKeys.heartbeat('workers'), String(OPEN - 1000)]]);
    expect((await (await make(forgedHb)).inject('/v1/health')).json()).toMatchObject({ workers: null, lag: null });
    await app!.close();
    const genuine = new Map([sealedHeartbeat('workers', OPEN - 2000), sealedHeartbeat('price-relay', OPEN - 1000)]);
    expect((await (await make(genuine)).inject('/v1/health')).json()).toMatchObject({ workers: 2, lag: 1 });
  });
});

// ── F-3, F-4: candles on mainnet ──────────────────────────────────────────────

describe('F-3 (B1): mainnet never serves simulated candles from the Redis cache', () => {
  const h = Math.floor((OPEN - 3_600_000) / 3_600_000) * 3_600_000;
  const demo: Candle[] = [{ t: h, o: '391.65', h: '395', l: '390', c: '392' }];
  const real: Candle[] = [{ t: h, o: '400.1', h: '401', l: '399.5', c: '400.6' }];
  const fromDb: Candle[] = [{ t: h, o: '400', h: '401', l: '399', c: '400.5' }];
  const mainnet = { network: 'mainnet' as const, chainId: 4663 };
  async function serve(entry: [string, string] | null, envOver: Partial<ApiEnv> = mainnet) {
    const queries: unknown[] = [];
    const a = await make(new Map(entry ? [entry] : []), envOver, { db: dbOf({ candles: async (...args) => (queries.push(args), fromDb) }) });
    const body = (await a.inject('/v1/markets/TSLA/candles?tf=1h')).json();
    await app!.close();
    app = undefined;
    return { body, queries };
  }
  it.each([
    ['the pre-F-2 format (a bare JSON array, the auditor probe)', [cacheKeys.candles('TSLA', '1h'), JSON.stringify(demo)] as [string, string]],
    ['demo history written by testnet workers', sealedCandles('TSLA', '1h', demo, 'demo', testMac)],
    ['demo history authenticated for mainnet', sealedCandles('TSLA', '1h', demo, 'demo', mainnetTestMac)],
    ['a payload claiming another network than its MAC', sealedCandles('TSLA', '1h', demo, 'robinhood', mainnetTestMac, 'testnet')],
  ])('ignores %s and answers from Postgres, real candles only', async (_name, entry) => {
    const { body, queries } = await serve(entry);
    expect(body).toEqual(fromDb);
    expect(queries).toEqual([['TSLA', '1h', 120, { until: OPEN + 30_000, realOnly: true }]]);
  });
  it('serves a real-source cache written for mainnet; testnet still serves its demo cache', async () => {
    expect((await serve(sealedCandles('TSLA', '1h', real, 'robinhood', mainnetTestMac))).body).toEqual(real);
    expect((await serve(sealedCandles('TSLA', '1h', demo, 'demo', testMac), {})).body).toEqual(demo);
  });
});

// Needs TEST_DATABASE_URL pointing at a migrated database. Skipped otherwise.
describe.skipIf(!process.env.TEST_DATABASE_URL)('F-4 on Postgres: mainnet candles are only those tagged with a real source', () => {
  it('candles of unknown source (NULL) and demo candles are never returned with realOnly', async () => {
    const { PrismaClient: Client } = await import('@velum/db');
    const prisma = new Client({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
    const h = Math.floor(OPEN / 3_600_000) * 3_600_000;
    try {
      const m = await prisma.market.upsert({ where: { symbol: 'ZZU' }, create: { symbol: 'ZZU', name: 'ZZU', status: 'live' }, update: {}, select: { id: true } });
      await prisma.candle.deleteMany({ where: { marketId: m.id } });
      const c = (i: number, source: string | null) => ({ marketId: m.id, tf: '1h', t: new Date(h - i * 3_600_000), o: '1', h: '1', l: '1', c: '1', source });
      await prisma.candle.createMany({ data: [c(4, null), c(3, 'demo'), c(2, 'robinhood'), c(1, 'chainlink'), c(0, null)] });
      const db = prismaDb(prisma);
      expect((await db.candles('ZZU', '1h', 10, { until: OPEN, realOnly: true })).map((x) => (h - x.t) / 3_600_000)).toEqual([2, 1]);
      expect(await db.candles('ZZU', '1h', 10, { until: OPEN })).toHaveLength(5);
    } finally {
      const m = await prisma.market.findUnique({ where: { symbol: 'ZZU' } });
      if (m) {
        await prisma.candle.deleteMany({ where: { marketId: m.id } });
        await prisma.market.delete({ where: { id: m.id } });
      }
      await prisma.$disconnect();
    }
  });
});

// ── F-6: unconfirmed quotes ───────────────────────────────────────────────────

describe('F-6: a quote not yet seen to change after a lost snapshot is not live', () => {
  it('session open: quoteFrozen, however recent its quote time; session closed: marketClosed', () => {
    const s = snap('TSLA', { unconfirmed: true, updatedAt: OPEN - 2000, checkedAt: OPEN - 1000 });
    expect(priceState(s, OPEN, 'mainnet')).toMatchObject({ stale: true, staleReason: 'quoteFrozen', marketOpen: true });
    expect(priceState({ ...s, updatedAt: SUNDAY - 2000, checkedAt: SUNDAY - 1000 }, SUNDAY, 'mainnet')).toMatchObject({ stale: true, staleReason: 'marketClosed' });
    const { unconfirmed: _u, ...confirmed } = s;
    expect(priceState(confirmed, OPEN, 'mainnet')).toMatchObject({ stale: false, staleReason: null });
    expect(QUOTE_FROZEN_AFTER_MS).toBe(15 * 60_000);
  });
  it('/v1/quote refuses it; the flag survives the trip through Redis', async () => {
    const a = await make(new Map([sealedSnapshot(snap('TSLA', { unconfirmed: true }), mainnetTestMac)]), { network: 'mainnet', chainId: 4663 });
    expect((await a.inject('/v1/markets/TSLA')).json()).toMatchObject({ stale: true, staleReason: 'quoteFrozen' });
    const q = await a.inject({ method: 'POST', url: '/v1/quote', payload: { from: 'USDG', to: 'TSLA', amount: '10' } });
    expect(q.json().error.code).toBe('STALE_PRICE');
  });
});

// ── F-7: HEAD and OPTIONS ─────────────────────────────────────────────────────

describe('F-7: HEAD shares the GET budget, OPTIONS is limited (auditor probes A1, A2)', () => {
  const codes = async (a: FastifyInstance, method: 'GET' | 'HEAD' | 'OPTIONS', url: string, n: number, ip: string) => {
    const out: number[] = [];
    const headers = method === 'OPTIONS' ? { origin: 'https://velum.example', 'access-control-request-method': 'POST' } : {};
    for (let i = 0; i < n; i++) out.push((await a.inject({ method, url, remoteAddress: ip, headers })).statusCode);
    return out;
  };
  it('A1: GET and HEAD /v1/health share one budget of 3', async () => {
    const a = await make(new Map(), { rateHealthPerMin: 3 });
    expect([...(await codes(a, 'GET', '/v1/health', 2, '203.0.113.9')), ...(await codes(a, 'HEAD', '/v1/health', 2, '203.0.113.9'))]).toEqual([200, 200, 200, 429]);
    expect(await codes(a, 'GET', '/v1/health', 1, '203.0.113.99')).toEqual([200]); // another client
  });
  it('HEAD /v1/markets shares the markets budget, a global-budget route already shared its budget', async () => {
    const a = await make(new Map(), { rateMarketsPerMin: 2, rateReadPerMin: 2 });
    expect([...(await codes(a, 'HEAD', '/v1/markets', 2, '203.0.113.20')), ...(await codes(a, 'GET', '/v1/markets', 1, '203.0.113.20'))]).toEqual([200, 200, 429]);
    expect([...(await codes(a, 'HEAD', '/v1/stats', 2, '203.0.113.21')), ...(await codes(a, 'GET', '/v1/stats', 1, '203.0.113.21'))]).toEqual([200, 200, 429]);
  });
  it('A2: 20 OPTIONS preflights with a read budget of 2: two answered, the rest 429; they share the read budget', async () => {
    const a = await make(new Map(), { rateReadPerMin: 2, rateQuotePerMin: 2 });
    const r = await codes(a, 'OPTIONS', '/v1/quote', 20, '203.0.113.10');
    expect(r.slice(0, 2)).toEqual([204, 204]);
    expect(new Set(r.slice(2))).toEqual(new Set([429]));
    expect(await codes(a, 'GET', '/v1/stats', 1, '203.0.113.10')).toEqual([429]);
    // The quote budget is its own: preflights did not spend it.
    const q = await a.inject({ method: 'POST', url: '/v1/quote', remoteAddress: '203.0.113.10', payload: { from: 'USDG', to: 'TSLA', amount: '1' } });
    expect(q.statusCode).not.toBe(429);
  });
  it('an OPTIONS request CORS does not answer (no allowed origins) is counted once, not twice', async () => {
    const a = await make(new Map(), { corsOrigins: false, rateReadPerMin: 3 });
    expect(await codes(a, 'OPTIONS', '/v1/stats', 4, '203.0.113.30')).toEqual([404, 404, 404, 429]);
  });
});

// ── With a real Redis ─────────────────────────────────────────────────────────

describe.skipIf(!process.env.TEST_REDIS_URL)('F-2, F-7 against a real Redis (TEST_REDIS_URL)', () => {
  it('a forged snapshot written with only the Redis password is refused; HEAD and GET share one Redis counter', async () => {
    const parsed = parseRedisUrl(process.env.TEST_REDIS_URL!);
    if (!parsed.ok) throw new Error(parsed.error);
    const admin = new Redis({ ...parsed.options, maxRetriesPerRequest: 1 });
    const client = new Redis({ ...parsed.options, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    client.on('error', () => undefined);
    const ip = '203.0.113.77';
    const mine = async () => (await admin.keys('velum:rl:*')).filter((k) => k.endsWith(ip)).sort();
    try {
      await new Promise((r) => client.once('ready', r));
      const forged = snap('TSLA', { price: '0.01', mark: '0.01', open24h: '0.01', spark: ['0.01'], updatedAt: OPEN, checkedAt: OPEN });
      await admin.set(cacheKeys.price('TSLA'), JSON.stringify(forged));
      let t = OPEN;
      app = await buildApp({
        env: { ...env, network: 'mainnet', chainId: 4663, rateHealthPerMin: 3 },
        cache: redisCache(client, { mac: mainnetTestMac, now: () => t }),
        db: dbOf(),
        chain: { blockNumber: async () => 1n },
        now: () => t,
        rateLimitRedis: client,
      });
      expect((await app.inject({ url: '/v1/markets/TSLA', remoteAddress: ip })).json()).toMatchObject({ stale: true, staleReason: 'noPrice' });
      await admin.set(...sealedSnapshot(snap('TSLA', { price: '392.5' }), mainnetTestMac));
      t += 2000; // past the 1 s markets cache
      expect((await app.inject({ url: '/v1/markets/TSLA', remoteAddress: ip })).json()).toMatchObject({ price: '392.5', stale: false });
      const r: number[] = [];
      for (const method of ['GET', 'HEAD', 'GET', 'HEAD'] as const) r.push((await app.inject({ method, url: '/v1/health', remoteAddress: ip })).statusCode);
      expect(r).toEqual([200, 200, 200, 429]);
      expect((await mine()).filter((k) => k.includes('/v1/health'))).toEqual([`velum:rl:GET/v1/health-ip:${ip}`]);
    } finally {
      await app?.close();
      app = undefined;
      const keys = [cacheKeys.price('TSLA'), ...(await mine())];
      await admin.del(...keys);
      client.disconnect();
      await admin.quit();
    }
  });
});
