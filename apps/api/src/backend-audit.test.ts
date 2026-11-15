/**
 * Regression tests for the full backend audit of 2026-11-15 (API side): M-1 frozen quotes and the
 * session calendar, M-2 untrusted Redis values, L-1 future candles, L-2 IPv6 /64 keys, L-3 socket without
 * proxy secret, L-4 Redis outage, L-5 markets cache, L-6 secret redaction, I-3/DV-03 demo numbers, I-4
 * caches, I-5 chain id and LOG_LEVEL, DV-08 demoMode, mainnet demo prices.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKETS, QUOTE_FROZEN_AFTER_MS, cacheKeys, easternOffsetMs, nyseHolidays, parseRedisUrl, usEquitySession, type Candle, type MarketSnapshot } from '@velum/config';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadEnv, type ApiEnv } from './env';
import { redisCache } from './lib/adapters';
import { addressKey, PROXY_SECRET_HEADER } from './lib/client-address';
import type { AppDeps, CacheReader, DbReader } from './lib/deps';
import { listenOnSocket } from './lib/listen';
import { priceState } from './lib/market-view';
import { fallbackStore } from './lib/rate-limit-store';
import { redact } from './lib/redact';

// Monday 2026-11-16 15:00 UTC = 10:00 ET: the regular session is open.
const OPEN = Date.UTC(2026, 10, 16, 15, 0, 0);
// Sunday 2026-11-15 06:21 UTC: when the auditor captured the frozen quote.
const SUNDAY = Date.UTC(2026, 10, 15, 6, 21, 29);

const env: ApiEnv = {
  host: '127.0.0.1',
  port: 0,
  databaseUrl: 'postgresql://x',
  redisUrl: 'redis://x',
  redis: { db: 0 },
  corsOrigins: false,
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

function cacheOf(snaps: MarketSnapshot[], extra: Partial<CacheReader> = {}): CacheReader {
  const map = new Map(snaps.map((s) => [s.symbol, s]));
  return {
    ping: async () => true,
    snapshots: async (syms) => new Map(syms.filter((s) => map.has(s)).map((s) => [s, map.get(s)!])),
    candles: async () => null,
    heartbeat: async (w) => (w ? OPEN - 2000 : null),
    ...extra,
  };
}
const dbOf = (over: Partial<DbReader> = {}): DbReader => ({ ping: async () => true, candles: async () => [], publishedPools: async () => [], ...over });

let app: FastifyInstance | undefined;
async function make(over: Partial<AppDeps> = {}, envOver: Partial<ApiEnv> = {}, now = OPEN) {
  app = await buildApp({ env: { ...env, ...envOver }, cache: cacheOf([snap('TSLA')]), db: dbOf(), chain: { blockNumber: async () => 1n }, now: () => now, ...over });
  return app;
}
afterEach(async () => {
  await app?.close();
  app = undefined;
});

// ── M-1: session calendar and frozen quotes ───────────────────────────────────

describe('M-1: US-equity session calendar (Robinhood 24/5: Sunday 20:00 to Friday 20:00 ET, US holidays closed)', () => {
  const et = (iso: string) => {
    // iso is a US Eastern wall-clock time; find the UTC instant.
    const guess = Date.parse(`${iso}Z`);
    return guess - easternOffsetMs(guess + 5 * 3_600_000);
  };
  it.each([
    ['2026-11-15T06:21:29Z (Sunday, the auditor capture)', SUNDAY, false, 'weekend'],
    ['Sunday 19:59 ET', et('2026-11-15T19:59:00'), false, 'weekend'],
    ['Sunday 20:00 ET (overnight session opens)', et('2026-11-15T20:00:00'), true, null],
    ['Monday 10:00 ET', OPEN, true, null],
    ['Friday 19:59 ET', et('2026-11-20T19:59:00'), true, null],
    ['Friday 20:00 ET', et('2026-11-20T20:00:00'), false, 'weekend'],
    ['Thanksgiving eve 20:00 ET', et('2026-11-25T20:00:00'), false, 'holiday'],
    ['Thanksgiving 12:00 ET', et('2026-11-26T12:00:00'), false, 'holiday'],
    ['Thanksgiving 20:00 ET (Friday trading day)', et('2026-11-26T20:00:00'), true, null],
    ['Good Friday 2027', et('2027-03-26T12:00:00'), false, 'holiday'],
    ['Saturday 2027-07-03 (Independence Day observed Monday)', et('2027-07-05T10:00:00'), false, 'holiday'],
    ['summer time: Monday 2026-07-06 09:30 EDT', et('2026-07-06T09:30:00'), true, null],
  ])('%s', (_name, t, open, reason) => {
    expect(usEquitySession(t as number)).toMatchObject({ open, reason });
  });
  it('knows the NYSE holidays (2026, 2027, and the unobserved Saturday New Year of 2028)', () => {
    expect([...nyseHolidays(2026)].sort()).toEqual(['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']);
    expect([...nyseHolidays(2027)].sort()).toEqual(['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']);
    expect(nyseHolidays(2028).has('2027-12-31')).toBe(false);
    expect([...nyseHolidays(2028)].some((d) => d.startsWith('2028-01-0'))).toBe(false);
  });
  it('switches daylight saving time on the US dates', () => {
    expect(easternOffsetMs(Date.UTC(2026, 2, 8, 6, 59))).toBe(-5 * 3_600_000);
    expect(easternOffsetMs(Date.UTC(2026, 2, 8, 7, 0))).toBe(-4 * 3_600_000);
    expect(easternOffsetMs(Date.UTC(2026, 10, 1, 5, 59))).toBe(-4 * 3_600_000);
    expect(easternOffsetMs(Date.UTC(2026, 10, 1, 6, 0))).toBe(-5 * 3_600_000);
  });
});

describe('M-1: a frozen or closed real quote is stale; demo prices on testnet are not', () => {
  it('48 h of the frozen Sunday quote: workers alive (checkedAt fresh), quote time old -> stale, marketClosed', () => {
    const s = snap('TSLA', { updatedAt: SUNDAY - 48 * 3_600_000, checkedAt: SUNDAY - 1000 });
    expect(priceState(s, SUNDAY, 'mainnet')).toEqual({ stale: true, staleReason: 'marketClosed', marketOpen: false, quoteAge: 48 * 3600 });
  });
  it('inside the session, a quote unchanged for 15 minutes is quoteFrozen; a moving one is live', () => {
    const frozen = snap('TSLA', { updatedAt: OPEN - QUOTE_FROZEN_AFTER_MS - 1000, checkedAt: OPEN - 1000 });
    expect(priceState(frozen, OPEN, 'mainnet')).toMatchObject({ stale: true, staleReason: 'quoteFrozen', marketOpen: true });
    const quiet = snap('TSLA', { updatedAt: OPEN - QUOTE_FROZEN_AFTER_MS + 60_000, checkedAt: OPEN - 1000 });
    expect(priceState(quiet, OPEN, 'mainnet')).toMatchObject({ stale: false, staleReason: null, quoteAge: 840 });
  });
  it('the pipeline must confirm the quote within a minute (outdated), and old snapshots without checkedAt still work', () => {
    expect(priceState(snap('TSLA', { checkedAt: OPEN - 61_000, updatedAt: OPEN - 61_000 }), OPEN, 'mainnet').staleReason).toBe('outdated');
    const legacy = snap('TSLA', { updatedAt: OPEN - 2000 });
    delete legacy.checkedAt;
    expect(priceState(legacy, OPEN, 'mainnet').stale).toBe(false);
  });
  it('demo prices: never live on mainnet (demoSource); on testnet they ignore the calendar', () => {
    const demo = snap('TSLA', { source: 'demo', updatedAt: SUNDAY - 1000, checkedAt: SUNDAY - 1000 });
    expect(priceState(demo, SUNDAY, 'mainnet')).toMatchObject({ stale: true, staleReason: 'demoSource' });
    expect(priceState(demo, SUNDAY, 'testnet')).toMatchObject({ stale: false, marketOpen: false });
  });
  it('/v1/markets exposes marketOpen, quoteAge and staleReason; /v1/quote refuses a closed market', async () => {
    const a = await make({ cache: cacheOf([snap('TSLA', { updatedAt: SUNDAY - 3_600_000, checkedAt: SUNDAY - 1000 })]) }, {}, SUNDAY);
    const tsla = ((await a.inject('/v1/markets')).json() as Array<Record<string, unknown>>).find((m) => m.symbol === 'TSLA');
    expect(tsla).toMatchObject({ stale: true, staleReason: 'marketClosed', marketOpen: false, quoteAge: 3600, source: 'robinhood', updatedAt: SUNDAY - 3_600_000 });
    const q = await a.inject({ method: 'POST', url: '/v1/quote', payload: { from: 'USDG', to: 'TSLA', amount: '10' } });
    expect(q.statusCode).toBe(503);
    expect(q.json().error).toEqual({ code: 'STALE_PRICE', message: 'The US stock market is closed, so the TSLA price is not live. Try again when it reopens.' });
  });
});

// ── M-2: values read from Redis are validated ─────────────────────────────────

function fakeRedis(store: Map<string, string>, opts: { hang?: boolean; fail?: boolean } = {}) {
  const run = <T>(v: T): Promise<T> => (opts.hang ? new Promise<T>(() => undefined) : opts.fail ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(v));
  return {
    ping: () => run('PONG'),
    mget: (...keys: string[]) => run(keys.map((k) => store.get(k) ?? null)),
    get: (k: string) => run(store.get(k) ?? null),
  } as unknown as Redis;
}

describe('M-2: snapshots, candles and heartbeats from Redis are validated', () => {
  it('a snapshot dated ten years ahead (P3) is ignored: seed price, stale, quote refused', async () => {
    const store = new Map([[cacheKeys.price('TSLA'), JSON.stringify(snap('TSLA', { price: '0.01', updatedAt: OPEN + 10 * 365 * 86_400_000, checkedAt: undefined }))]]);
    const a = await make({ cache: redisCache(fakeRedis(store), { now: () => OPEN }) });
    expect((await a.inject('/v1/markets/TSLA')).json()).toMatchObject({ price: '391.65', stale: true, staleReason: 'noPrice', source: null });
    expect((await a.inject({ method: 'POST', url: '/v1/quote', payload: { from: 'USDG', to: 'TSLA', amount: '1000' } })).statusCode).toBe(503);
  });
  it('a 200k-point spark (P3b) is ignored, so /v1/markets stays small', async () => {
    const store = new Map([[cacheKeys.price('TSLA'), JSON.stringify(snap('TSLA', { spark: Array.from({ length: 200_000 }, () => '391.65') }))]]);
    const a = await make({ cache: redisCache(fakeRedis(store), { now: () => OPEN }) });
    const res = await a.inject('/v1/markets');
    expect(res.body.length).toBeLessThan(20_000);
    expect((res.json() as Array<{ symbol: string; stale: boolean }>).find((m) => m.symbol === 'TSLA')!.stale).toBe(true);
  });
  it('rejects bad prices, unknown sources, mislabelled symbols and >60 spark points; accepts a good one', async () => {
    const store = new Map<string, string>([
      [cacheKeys.price('TSLA'), JSON.stringify(snap('TSLA'))],
      [cacheKeys.price('AMZN'), JSON.stringify(snap('AMZN', { price: '-1' }))],
      [cacheKeys.price('PLTR'), JSON.stringify(snap('PLTR', { source: 'binance' as never }))],
      [cacheKeys.price('NFLX'), JSON.stringify(snap('TSLA'))],
      [cacheKeys.price('AMD'), JSON.stringify(snap('AMD', { spark: Array.from({ length: 61 }, () => '1') }))],
      [cacheKeys.price('AAPL'), JSON.stringify(snap('AAPL', { price: '1000000000' }))],
    ]);
    const out = await redisCache(fakeRedis(store), { now: () => OPEN }).snapshots(MARKETS.map((m) => m.symbol));
    expect([...out.keys()]).toEqual(['TSLA']);
  });
  it('a cached candle series with a future, misaligned or inconsistent bucket is ignored; Postgres never serves future buckets (L-1)', async () => {
    const h = Math.floor(OPEN / 3_600_000) * 3_600_000;
    const c = (t: number, over: Partial<Candle> = {}): Candle => ({ t, o: '1', h: '2', l: '0.5', c: '1.5', ...over });
    const reader = (series: Candle[]) => redisCache(fakeRedis(new Map([[cacheKeys.candles('TSLA', '1h'), JSON.stringify(series)]])), { now: () => OPEN });
    expect(await reader([c(h - 3_600_000), c(h)]).candles('TSLA', '1h')).toHaveLength(2);
    expect(await reader([c(h), c(h + 365 * 86_400_000)]).candles('TSLA', '1h')).toBeNull();
    expect(await reader([c(h + 1)]).candles('TSLA', '1h')).toBeNull();
    expect(await reader([c(h, { l: '3' })]).candles('TSLA', '1h')).toBeNull();
    expect(await reader([c(h), c(h - 3_600_000)]).candles('TSLA', '1h')).toBeNull();
    const queries: unknown[] = [];
    const a = await make({ cache: reader([c(h + 365 * 86_400_000)]), db: dbOf({ candles: async (...args) => (queries.push(args), [c(h)]) }) });
    expect((await a.inject('/v1/markets/TSLA/candles?tf=1h&limit=5')).json()).toEqual([c(h)]);
    expect(queries).toEqual([['TSLA', '1h', 5, { until: OPEN + 30_000, realOnly: false }]]);
  });
  it('a heartbeat dated ahead does not make dead workers look alive', async () => {
    const store = new Map([[cacheKeys.heartbeat('workers'), String(OPEN + 86_400_000)]]);
    expect(await redisCache(fakeRedis(store), { now: () => OPEN }).heartbeat('workers')).toBeNull();
  });
});

// ── L-2, L-3: client keys ─────────────────────────────────────────────────────

describe('L-2: IPv6 clients are keyed by their /64', () => {
  it('normalises addresses', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:DB8:0001:0002:0:0:0:abcd')).toBe('2001:db8:1:2::/64');
    expect(addressKey('::ffff:198.51.100.4')).toBe('198.51.100.4');
    expect(addressKey('::ffff:c633:6404')).toBe('198.51.100.4');
    expect(addressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(addressKey('velum-deploy-1234')).toBe('velum-deploy-1234');
  });
  it('400 addresses rotated inside one /64 (P2) share one budget', async () => {
    const secret = 'ab'.repeat(16);
    const a = await make({}, { proxySecret: secret, rateReadPerMin: 120 });
    let limited = 0;
    for (let i = 0; i < 400; i++) {
      const r = await a.inject({ url: '/v1/stats', headers: { [PROXY_SECRET_HEADER]: secret, 'x-real-ip': `2001:db8:1:2::${(i + 1).toString(16)}` } });
      if (r.statusCode === 429) limited++;
    }
    expect(limited).toBe(280);
    const other = await a.inject({ url: '/v1/stats', headers: { [PROXY_SECRET_HEADER]: secret, 'x-real-ip': '2001:db8:1:3::1' } });
    expect(other.statusCode).toBe(200);
  });
});

describe('L-3: API_SOCKET needs PROXY_SECRET, and the key generator never fails a request', () => {
  it('loadEnv refuses API_SOCKET without PROXY_SECRET', () => {
    const base = { DATABASE_URL: 'postgresql://a', REDIS_URL: 'redis://b', API_SOCKET: '/run/velum-api/api.sock' };
    expect(() => loadEnv(base)).toThrow(/API_SOCKET is set but PROXY_SECRET is empty/);
    expect(loadEnv({ ...base, PROXY_SECRET: 'ab'.repeat(16) }).socketPath).toBe('/run/velum-api/api.sock');
  });
  it('on a unix socket without a secret (P1), requests answer 200, not 500', async () => {
    const dir = mkdtempSync(join(tmpdir().length < 60 ? tmpdir() : '/tmp', 'vl3-'));
    const sock = join(dir, 'api.sock');
    try {
      const a = await make({}, { socketPath: sock });
      await listenOnSocket(a, sock);
      const status = await new Promise<number>((resolve, reject) => {
        const r = request({ socketPath: sock, path: '/v1/stats', headers: { 'x-forwarded-for': '198.51.100.1' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on('error', reject);
        r.end();
      });
      expect(status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── L-4, L-5: Redis outage and the markets cache ──────────────────────────────

describe('L-4: a Redis outage degrades instead of failing', () => {
  it('markets answer fast from the last known values, all stale "unavailable"; quote answers 503 UNAVAILABLE', async () => {
    const store = new Map([[cacheKeys.price('TSLA'), JSON.stringify(snap('TSLA', { price: '392.10' }))]]);
    const live = { down: false };
    const r = {
      ping: () => (live.down ? new Promise(() => undefined) : Promise.resolve('PONG')),
      mget: (...keys: string[]) => (live.down ? new Promise(() => undefined) : Promise.resolve(keys.map((k) => store.get(k) ?? null))),
      get: () => (live.down ? new Promise(() => undefined) : Promise.resolve(null)),
    } as unknown as Redis;
    let t = OPEN;
    const a = await make({ cache: redisCache(r, { now: () => t }), now: () => t });
    expect(((await a.inject('/v1/markets')).json() as Array<{ symbol: string; stale: boolean }>).find((m) => m.symbol === 'TSLA')!.stale).toBe(false);
    live.down = true;
    t += 5000; // past the 1 s markets cache
    const t0 = performance.now();
    const res = await a.inject('/v1/markets');
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ symbol: string; price: string; stale: boolean; staleReason: string }>;
    expect(body.find((m) => m.symbol === 'TSLA')).toMatchObject({ price: '392.10', stale: true, staleReason: 'unavailable' });
    expect(body.every((m) => m.stale && m.staleReason === 'unavailable')).toBe(true);
    const q = await a.inject({ method: 'POST', url: '/v1/quote', payload: { from: 'USDG', to: 'TSLA', amount: '10' } });
    expect(q.statusCode).toBe(503);
    expect(q.json().error.code).toBe('UNAVAILABLE');
    expect((await a.inject('/v1/markets/TSLA/candles')).statusCode).toBe(200);
  });
  it('the rate limit keeps working, per process, while the Redis store fails (P4: 10 requests, max 3)', async () => {
    const failing = {
      defineCommand(name: string) {
        (this as Record<string, unknown>)[name] = () => Promise.reject(new Error('ECONNREFUSED'));
      },
    } as unknown as Redis;
    const a = await make({ rateLimitRedis: failing }, { rateReadPerMin: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await a.inject('/v1/stats')).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429, 429, 429, 429, 429, 429]);
  });
  it('the store counts in Redis when it answers', async () => {
    const counts = new Map<string, number>();
    const redis = {
      defineCommand(name: string) {
        (this as Record<string, unknown>)[name] =
          name === 'velumRateIncr' ? async (key: string, win: number) => [counts.set(key, (counts.get(key) ?? 0) + 1).get(key)!, win] : async () => [0, 0];
      },
    } as unknown as Redis;
    const Store = fallbackStore({ redis });
    const store = new Store();
    const res = await new Promise<{ current: number }>((resolve) => store.incr('k', (_e, r) => resolve(r!), 60_000));
    expect(res.current).toBe(1);
    expect(counts.get('velum:rl:k')).toBe(1);
  });
});

describe('L-5: /v1/markets is cached for a second and has its own, higher budget', () => {
  it('many polls within a second cost one cache read', async () => {
    let reads = 0;
    let t = OPEN;
    const a = await make({ cache: cacheOf([snap('TSLA')], { snapshots: async (syms) => (reads++, new Map(syms.includes('TSLA') ? [['TSLA', snap('TSLA')]] : [])) }), now: () => t });
    for (let i = 0; i < 20; i++) await a.inject('/v1/markets');
    expect(reads).toBe(1);
    t += 1000;
    await a.inject('/v1/markets');
    expect(reads).toBe(2);
  });
  it('markets polling does not spend the read budget, and vice versa', async () => {
    const a = await make({}, { rateReadPerMin: 2, rateMarketsPerMin: 5 });
    for (let i = 0; i < 5; i++) expect((await a.inject('/v1/markets')).statusCode).toBe(200);
    expect((await a.inject('/v1/markets')).statusCode).toBe(429);
    expect((await a.inject('/v1/stats')).statusCode).toBe(200);
    expect(loadEnv({ DATABASE_URL: 'postgresql://a', REDIS_URL: 'redis://b' }).rateMarketsPerMin).toBe(600);
  });
});

// ── I-3 / DV-03 / DV-08 / mainnet ─────────────────────────────────────────────

describe('DV-03: demo numbers are flagged on testnet and null on mainnet', () => {
  it('testnet: markets, stats and seeded pools say demo: true', async () => {
    const a = await make();
    const m = ((await a.inject('/v1/markets')).json() as Array<Record<string, unknown>>)[0]!;
    expect(m).toMatchObject({ demo: true, openInterest: '742000', fundingPerHour: '0.0042' });
    expect((await a.inject('/v1/stats')).json()).toMatchObject({ demo: true, openInterest: '4977000' });
    expect(((await a.inject('/v1/pools')).json() as Array<Record<string, unknown>>)[0]).toMatchObject({ demo: true, sizeRounded: '1200000' });
  });
  it('mainnet: numbers without a real source are null, and demo-sourced prices are never live', async () => {
    const a = await make({ cache: cacheOf([snap('TSLA', { source: 'demo' })]) }, { network: 'mainnet', chainId: 4663 });
    const tsla = ((await a.inject('/v1/markets')).json() as Array<Record<string, unknown>>).find((m) => m.symbol === 'TSLA')!;
    expect(tsla).toMatchObject({ demo: false, openInterest: null, fundingPerHour: null, stale: true, staleReason: 'demoSource', source: 'demo' });
    expect((await a.inject('/v1/stats')).json()).toEqual({ markets: 10, openInterest: null, shieldedValue: null, proofsToday: null, demo: false });
    const pools = (await a.inject('/v1/pools')).json() as Array<Record<string, unknown>>;
    expect(pools.every((p) => p.sizeRounded === null && p.aprEst === null && p.demo === false)).toBe(true);
  });
  it('mainnet candles from Postgres are real-source only (I-7)', async () => {
    const queries: unknown[] = [];
    const a = await make({ db: dbOf({ candles: async (...args) => (queries.push(args[3]), []) }) }, { network: 'mainnet', chainId: 4663 });
    await a.inject('/v1/markets/TSLA/candles?tf=15m');
    expect(queries).toEqual([{ until: OPEN + 30_000, realOnly: true }]);
  });
});

describe('DV-08 / I-5: health reports demoMode true and a wrong-chain RPC as unhealthy', () => {
  it('demoMode is always true in Phase 2', async () => {
    const a = await make();
    expect((await a.inject('/v1/health')).json()).toMatchObject({ ok: true, demoMode: true, rpcChainId: null });
    expect(loadEnv({ DATABASE_URL: 'postgresql://a', REDIS_URL: 'redis://b', DEMO_MODE: 'false' }).demoMode).toBe(true);
  });
  it('rpcChainId: matching is ok, another chain is 503, unreachable (null) does not fail', async () => {
    for (const [id, status] of [
      [46630, 200],
      [4663, 503],
      [null, 200],
    ] as const) {
      const a = await make({ chain: { blockNumber: async () => 1n, chainId: async () => id } });
      const res = await a.inject('/v1/health');
      expect(res.statusCode, String(id)).toBe(status);
      expect(res.json().rpcChainId).toBe(id);
      // deploy.sh reads "workers":<n> followed by another field.
      expect(res.body).toMatch(/"workers":\d{1,9}[,}]/);
      await a.close();
      app = undefined;
    }
  });
  it('LOG_LEVEL must be a pino level', () => {
    expect(() => loadEnv({ DATABASE_URL: 'postgresql://a', REDIS_URL: 'redis://b', LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL must be one of/);
    expect(loadEnv({ DATABASE_URL: 'postgresql://a', REDIS_URL: 'redis://b', LOG_LEVEL: 'warn' }).logLevel).toBe('warn');
  });
});

describe('I-4: pools are cached; concurrent candle fallbacks share one query', () => {
  it('/v1/pools hits Postgres once per 30 s', async () => {
    let calls = 0;
    let t = OPEN;
    const a = await make({ db: dbOf({ publishedPools: async () => (calls++, []) }), now: () => t });
    for (let i = 0; i < 5; i++) await a.inject('/v1/pools');
    expect(calls).toBe(1);
    t += 30_000;
    await a.inject('/v1/pools');
    expect(calls).toBe(2);
  });
  it('ten simultaneous candle requests with a cold cache run one database query', async () => {
    let calls = 0;
    const a = await make({ db: dbOf({ candles: async () => (calls++, await new Promise((r) => setTimeout(r, 20)), []) }) });
    await Promise.all(Array.from({ length: 10 }, () => a.inject('/v1/markets/TSLA/candles?tf=4h&limit=50')));
    expect(calls).toBe(1);
  });
});

describe('M-2: REDIS_URL may name the dedicated unix socket', () => {
  it('parses socket and TCP forms', () => {
    expect(parseRedisUrl('unix://:abc123abc123@/run/velum-redis/redis.sock')).toEqual({ ok: true, options: { path: '/run/velum-redis/redis.sock', db: 0, password: 'abc123abc123' } });
    expect(parseRedisUrl('redis+unix:///run/velum-redis/redis.sock?db=2&password=p%40ss')).toEqual({ ok: true, options: { path: '/run/velum-redis/redis.sock', db: 2, password: 'p@ss' } });
    expect(parseRedisUrl('rediss://user:pw@redis.example:6380/1')).toEqual({ ok: true, options: { host: 'redis.example', port: 6380, db: 1, username: 'user', password: 'pw', tls: {} } });
    for (const bad of ['unix://run/redis.sock', 'unix:///run/../etc/x.sock', 'unix:///run/r.sock?foo=1', 'redis://:pw@127.0.0.1:6379/abc', 'tcp://127.0.0.1']) expect(parseRedisUrl(bad).ok, bad).toBe(false);
  });
});

describe('L-6: secret values from the environment are redacted', () => {
  it('a password that ends the URL early never leaks', () => {
    for (const pw of ['s3cr3t pass', 's3cr3t"pass', 's3cr3t<pass>', 's3cr3t`pass', 'pa%20ss word', 'Pässwört€']) {
      const e = { REDIS_URL: `redis://:${pw}@127.0.0.1:6379/5`, DATABASE_URL: `postgresql://velum:${pw}@127.0.0.1:5432/velum` };
      const out = redact(`Error: connect redis://:${pw}@127.0.0.1:6379/5 failed; DATABASE_URL=postgresql://velum:${pw}@127.0.0.1:5432/velum`, e);
      for (const frag of ['pass', 'word', 'rt€']) if (pw.includes(frag)) expect(out, out).not.toContain(frag);
    }
    expect(redact('x PROXY ' + 'ab'.repeat(16), { PROXY_SECRET: 'ab'.repeat(16) })).toBe('x PROXY ***');
  });
});
