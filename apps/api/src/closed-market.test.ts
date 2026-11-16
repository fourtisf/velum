/**
 * Closed-market fields (docs/03): `change` with `changeBasis` "24h" | "lastSession" | "dexSinceClose", `lastSession`,
 * `dex`, and the candles session view (`sessions=true`). Old fields keep their meaning; a closed market stays
 * untradable on mainnet exactly as before.
 */
import { DEX_CACHE_KEY, dexPoolsOf, type Candle, type DexSnapshot, type MarketSnapshot } from '@velum/config';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { mainnetTestMac, sealedSnapshot, testMac } from './__fixtures__/mac';
import { buildApp } from './app';
import type { ApiEnv } from './env';
import { redisCache } from './lib/adapters';
import type { AppDeps, DbReader } from './lib/deps';

const Z = (s: string) => Date.parse(s);
const H = 3_600_000;
// Sunday 2026-11-15 12:00 ET: closed since Friday 20:00 EST (Sat 01:00 UTC). Last session Fri Nov 13, previous Thu Nov 12.
const SUNDAY = Z('2026-11-15T17:00:00Z');
// Wednesday 2026-11-18 10:00 ET: open.
const OPEN = Z('2026-11-18T15:00:00Z');
const FRI_CLOSE_BUCKET = Z('2026-11-14T01:00:00Z') - 15 * 60_000;
const THU_CLOSE_BUCKET = Z('2026-11-13T01:00:00Z') - 15 * 60_000;

const env: ApiEnv = {
  host: '127.0.0.1',
  port: 0,
  databaseUrl: 'postgresql://velum:test-only@127.0.0.1:5432/velum',
  redisUrl: 'redis://x',
  redis: { db: 0 },
  corsOrigins: false,
  rateReadPerMin: 1000,
  rateQuotePerMin: 30,
  rateHealthPerMin: 60,
  rateMarketsPerMin: 1000,
  rpcUrl: 'http://localhost:1',
  chainId: 4663,
  network: 'mainnet',
  demoMode: true,
  logLevel: 'silent',
  proxySecret: null,
  socketPath: null,
};

const snap = (symbol: string, now: number, over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  symbol,
  price: '391.65',
  mark: '391.8',
  open24h: '391.65',
  spark: ['391.65'],
  source: 'robinhood',
  updatedAt: Z('2026-11-14T00:59:58Z'),
  checkedAt: now - 1000,
  ...over,
});

const NVDA_POOL = dexPoolsOf('mainnet').NVDA!.pool;
const dexSnap = (now: number, over: Partial<DexSnapshot> = {}): DexSnapshot => ({
  symbol: 'NVDA',
  pool: NVDA_POOL,
  price: '161.27',
  tradeAt: now - 5 * 60_000,
  block: 115_100_000,
  liquidityUsdg: '1922052.5',
  usdgSide: '408421',
  tokenSideUsdg: '1513631.5',
  belowThreshold: false,
  liquidityAt: now - 60_000,
  checkedAt: now - 10_000,
  // The pool's own price at Friday's close (its last trade before 20:00 EST).
  close: { end: Z('2026-11-14T01:00:00Z'), price: '161.1', at: Z('2026-11-14T00:58:00Z') },
  ...over,
});

function fakeRedis(store: Map<string, string>) {
  return { ping: async () => 'PONG', mget: async (...keys: string[]) => keys.map((k) => store.get(k) ?? null), get: async (k: string) => store.get(k) ?? null } as unknown as Redis;
}
const sealDex = (s: DexSnapshot, mac = mainnetTestMac): [string, string] => [DEX_CACHE_KEY(s.symbol), mac.seal(DEX_CACHE_KEY(s.symbol), JSON.stringify(s))];

const closes = new Map([
  ['TSLA', new Map([[FRI_CLOSE_BUCKET, '391.65'], [THU_CLOSE_BUCKET, '396.56']])],
  ['NVDA', new Map([[FRI_CLOSE_BUCKET, '155.145'], [THU_CLOSE_BUCKET, '150']])],
  ['AMZN', new Map([[FRI_CLOSE_BUCKET, '263.19']])], // Thursday's close not stored
]);
const dbOf = (over: Partial<DbReader> = {}): DbReader => ({
  ping: async () => true,
  candles: async () => [],
  publishedPools: async () => [],
  closesAt: async (ts) => new Map([...closes].map(([s, m]) => [s, new Map([...m].filter(([t]) => ts.includes(t)))])),
  ...over,
});

let app: FastifyInstance | undefined;
async function make(store: Map<string, string>, now: number, envOver: Partial<ApiEnv> = {}, over: Partial<AppDeps> = {}) {
  const network = envOver.network ?? env.network;
  const mac = network === 'mainnet' ? mainnetTestMac : testMac;
  app = await buildApp({ env: { ...env, ...envOver }, cache: redisCache(fakeRedis(store), { mac, now: () => now }), db: dbOf(), chain: { blockNumber: async () => 1n }, now: () => now, ...over });
  return app;
}
afterEach(async () => {
  await app?.close();
  app = undefined;
});

type M = Record<string, unknown> & { symbol: string };
const markets = async (a: FastifyInstance): Promise<Record<string, M>> => Object.fromEntries(((await a.inject('/v1/markets')).json() as M[]).map((m) => [m.symbol, m]));

describe('change basis while open and closed', () => {
  it('open: rolling 24 h (change = change24h), no lastSession, no dex', async () => {
    const store = new Map([sealedSnapshot(snap('TSLA', OPEN, { open24h: '386.20', updatedAt: OPEN - 2000 }), mainnetTestMac)]);
    const m = (await markets(await make(store, OPEN))).TSLA!;
    expect(m).toMatchObject({ change24h: '1.41', change: '1.41', changeBasis: '24h', lastSession: null, dex: null, marketOpen: true, stale: false });
  });

  it('closed (Sunday): the last session (Friday close vs Thursday close), from stored candles; still untradable', async () => {
    const store = new Map([sealedSnapshot(snap('TSLA', SUNDAY), mainnetTestMac), sealedSnapshot(snap('AMZN', SUNDAY, { price: '263.19', open24h: '263.19' }), mainnetTestMac)]);
    const all = await markets(await make(store, SUNDAY));
    expect(all.TSLA).toMatchObject({
      change24h: '0.00', // kept as before: the rolling 24 h of a frozen quote
      change: '-1.24',
      changeBasis: 'lastSession',
      lastSession: { tradingDay: '2026-11-13', end: Z('2026-11-14T01:00:00Z'), close: '391.65', prevClose: '396.56', change: '-1.24' },
      dex: null,
      stale: true,
      staleReason: 'marketClosed',
      marketOpen: false,
    });
    // Thursday's close is not in the history: no change, never an estimate.
    expect(all.AMZN).toMatchObject({ change: null, changeBasis: 'lastSession', lastSession: { close: '263.19', prevClose: null, change: null } });
  });

  it('closed without any stored close (or the query failing): a null change, the route still answers', async () => {
    const store = new Map([sealedSnapshot(snap('TSLA', SUNDAY), mainnetTestMac)]);
    const a = await make(store, SUNDAY, {}, { db: dbOf({ closesAt: async () => Promise.reject(new Error('db down')) }) });
    const m = (await markets(a)).TSLA!;
    expect(m).toMatchObject({ change: null, changeBasis: 'lastSession', lastSession: { tradingDay: '2026-11-13', close: null, prevClose: null, change: null } });
  });

  it('testnet demo prices ignore the calendar: rolling 24 h even on a Sunday', async () => {
    const store = new Map([sealedSnapshot(snap('TSLA', SUNDAY, { source: 'demo', open24h: '386.20', updatedAt: SUNDAY - 2000 }), testMac)]);
    const m = (await markets(await make(store, SUNDAY, { network: 'testnet', chainId: 46630 }))).TSLA!;
    expect(m).toMatchObject({ change: '1.41', changeBasis: '24h', lastSession: null, dex: null, stale: false });
  });

  it('the single-market route carries the same fields', async () => {
    const store = new Map([sealedSnapshot(snap('TSLA', SUNDAY), mainnetTestMac)]);
    const m = (await (await make(store, SUNDAY)).inject('/v1/markets/TSLA')).json() as M;
    expect(m).toMatchObject({ change: '-1.24', changeBasis: 'lastSession' });
  });
});

describe('on-chain DEX price while closed (display only)', () => {
  const base = () => new Map([sealedSnapshot(snap('NVDA', SUNDAY, { price: '155.145', open24h: '155.145' }), mainnetTestMac)]);

  it('a fresh pool above the threshold with a trade since the close: dexSinceClose, the pool vs its own close', async () => {
    const store = base();
    store.set(...sealDex(dexSnap(SUNDAY)));
    const m = (await markets(await make(store, SUNDAY))).NVDA!;
    expect(m).toMatchObject({
      price: '155.145', // the official last quote stays the price
      change: '0.11',
      changeBasis: 'dexSinceClose',
      // 161.27 now vs 161.1 at Friday's close: the pool's standing 3.8% gap to the official quote is not a move.
      dex: { price: '161.27', change: '0.11', closeRef: '161.1', closeAt: Z('2026-11-14T00:58:00Z'), pool: NVDA_POOL, liquidityUsdg: '1922052.5', block: 115_100_000, tradeAt: SUNDAY - 300_000 },
      lastSession: { close: '155.145', prevClose: '150', change: '3.43' },
      stale: true,
      staleReason: 'marketClosed',
    });
  });

  it('without a pool trade near the close (or one for another session) the DEX change is null, never a cross-venue figure', async () => {
    for (const close of [null, { end: Z('2026-11-13T01:00:00Z'), price: '160', at: Z('2026-11-13T00:59:00Z') }]) {
      const store = base();
      store.set(...sealDex(dexSnap(SUNDAY, { close })));
      const m = (await markets(await make(store, SUNDAY))).NVDA!;
      expect(m).toMatchObject({ change: null, changeBasis: 'dexSinceClose', dex: { price: '161.27', change: null, closeRef: null, closeAt: null } });
      await app?.close();
      app = undefined;
    }
  });

  it('falls back to the last session when the pool is under the threshold, stale, traded only before the close, or is another pool', async () => {
    for (const bad of [
      dexSnap(SUNDAY, { belowThreshold: true }),
      dexSnap(SUNDAY, { checkedAt: SUNDAY - 11 * 60_000 }),
      dexSnap(SUNDAY, { liquidityAt: SUNDAY - 31 * 60_000 }),
      dexSnap(SUNDAY, { tradeAt: Z('2026-11-14T00:30:00Z') }),
    ]) {
      const store = base();
      store.set(...sealDex(bad));
      const m = (await markets(await make(store, SUNDAY))).NVDA!;
      expect(m).toMatchObject({ changeBasis: 'lastSession', change: '3.43', dex: null });
      await app?.close();
      app = undefined;
    }
    // Another pool's snapshot (or one sealed for testnet) never verifies.
    const store = base();
    store.set(...sealDex(dexSnap(SUNDAY, { pool: '0x0000000000000000000000000000000000000001' })));
    expect((await markets(await make(store, SUNDAY))).NVDA).toMatchObject({ dex: null });
    await app?.close();
    const store2 = base();
    store2.set(...sealDex(dexSnap(SUNDAY), testMac));
    expect((await markets(await make(store2, SUNDAY))).NVDA).toMatchObject({ dex: null });
  });

  it('never while the market is open', async () => {
    const store = new Map([sealedSnapshot(snap('NVDA', OPEN, { price: '155.145', open24h: '155.145', updatedAt: OPEN - 1000 }), mainnetTestMac)]);
    store.set(...sealDex(dexSnap(OPEN)));
    expect((await markets(await make(store, OPEN))).NVDA).toMatchObject({ changeBasis: '24h', dex: null, lastSession: null });
  });
});

describe('candles session view (sessions=true)', () => {
  const c = (t: number, o: string, h = o, l = o, cl = o): Candle => ({ t, o, h, l, c: cl });
  // Hourly quote candles from Friday 17:00 EST to Sunday 12:00 EST: three open hours, then the frozen close.
  const fri = Z('2026-11-13T22:00:00Z');
  const hourly = [c(fri, '390', '391', '389.5', '390.5'), c(fri + H, '390.5', '392', '390', '391.9'), c(fri + 2 * H, '391.9', '392', '391', '391.65')];
  for (let t = fri + 3 * H; t <= SUNDAY - H; t += H) hourly.push(c(t, '391.65'));

  it('leaves out closed hours that only repeat the close; the default view is unchanged', async () => {
    const db = dbOf({ candles: async (_s, tf) => (tf === '1h' ? hourly : []) });
    const a = await make(new Map(), SUNDAY, {}, { db });
    const plain = (await a.inject('/v1/markets/TSLA/candles?tf=1h&limit=300')).json() as Candle[];
    expect(plain.length).toBe(hourly.length);
    const view = (await a.inject('/v1/markets/TSLA/candles?tf=1h&limit=300&sessions=true')).json() as Candle[];
    expect(view.map((k) => k.t)).toEqual([fri, fri + H, fri + 2 * H]);
  });

  it('fills closed time with the pool DEX candles (src "dex") while the pool passes; dex=false leaves them out', async () => {
    const dexHours = [c(Z('2026-11-14T10:00:00Z'), '160', '161', '159.5', '160.8'), c(Z('2026-11-14T11:00:00Z'), '160.8', '161.3', '160.5', '161.27'), c(fri + 2 * H, '155', '156', '154', '155.5')];
    const db = dbOf({ candles: async (_s, tf) => (tf === '1h' ? hourly.map((k) => ({ ...k })) : []), dexCandles: async () => dexHours });
    const store = new Map([sealDex(dexSnap(SUNDAY))]);
    const a = await make(store, SUNDAY, {}, { db });
    const view = (await a.inject('/v1/markets/NVDA/candles?tf=1h&limit=300&sessions=true')).json() as Array<Candle & { src?: string }>;
    // The DEX hour at Friday 19:00 EST is in open time: never shown (the official candle is there).
    expect(view.map((k) => [k.t, k.src ?? 'quote'])).toEqual([
      [fri, 'quote'],
      [fri + H, 'quote'],
      [fri + 2 * H, 'quote'],
      [Z('2026-11-14T10:00:00Z'), 'dex'],
      [Z('2026-11-14T11:00:00Z'), 'dex'],
    ]);
    const noDex = (await a.inject('/v1/markets/NVDA/candles?tf=1h&limit=300&sessions=true&dex=false')).json() as Array<{ src?: string }>;
    expect(noDex.some((k) => k.src === 'dex')).toBe(false);
  });

  it('pool under the threshold: no DEX candles', async () => {
    const db = dbOf({ candles: async () => hourly, dexCandles: async () => [c(Z('2026-11-14T10:00:00Z'), '160')] });
    const a = await make(new Map([sealDex(dexSnap(SUNDAY, { belowThreshold: true }))]), SUNDAY, {}, { db });
    const view = (await a.inject('/v1/markets/NVDA/candles?tf=1h&limit=300&sessions=true')).json() as Array<{ src?: string }>;
    expect(view.some((k) => k.src === 'dex')).toBe(false);
  });

  it('1D: one candle per trading day built from the hourly candles (mainnet), plus one DEX candle per closed period', async () => {
    // Thursday Nov 12 and Friday Nov 13 sessions (EST), the frozen weekend, DEX trades on Saturday.
    const hours: Candle[] = [];
    for (let t = Z('2026-11-12T01:00:00Z'), i = 0; t < Z('2026-11-14T01:00:00Z'); t += H, i++) hours.push(c(t, String(380 + i / 4), String(381 + i / 4), String(379 + i / 4), String(380.25 + i / 4)));
    for (let t = Z('2026-11-14T01:00:00Z'); t < SUNDAY; t += H) hours.push(c(t, '392')); // repeats Friday's close
    const between: Array<[string, number]> = [];
    const db = dbOf({
      candlesBetween: async (s, tf, since) => (between.push([tf, since]), tf === '1h' ? hours : []),
      dexCandles: async () => [c(Z('2026-11-14T10:00:00Z'), '392', '393', '391', '392.5'), c(Z('2026-11-14T11:00:00Z'), '392.5', '394', '392', '393')],
    });
    const a = await make(new Map([sealDex({ ...dexSnap(SUNDAY), symbol: 'TSLA', pool: dexPoolsOf('mainnet').TSLA!.pool })]), SUNDAY, {}, { db });
    const view = (await a.inject('/v1/markets/TSLA/candles?tf=1D&limit=5&sessions=true')).json() as Array<Candle & { src?: string; end?: number }>;
    expect(view.map((k) => [new Date(k.t).toISOString().slice(0, 10), k.src ?? 'quote'])).toEqual([
      ['2026-11-12', 'quote'],
      ['2026-11-13', 'quote'],
      ['2026-11-14', 'dex'],
    ]);
    expect(view[1]).toMatchObject({ o: '386', c: '392' }); // Friday: first hour after Thu 20:00 EST opens, the 19:00 hour closes
    expect(view[2]).toMatchObject({ t: Z('2026-11-14T01:00:00Z'), end: Z('2026-11-16T01:00:00Z'), o: '392', h: '394', l: '391', c: '393' });
    // The hourly history read starts at the session of the 5th trading day back (Sunday -> Mon Nov 9's session).
    expect(between[0]).toEqual(['1h', Z('2026-11-09T01:00:00Z')]);
  });

  it('testnet 1D keeps the daily series (simulated prices trade every day), minus closed days that only repeat', async () => {
    // The UTC Saturday holds Friday's last trading hour in winter (19:00-20:00 EST): not wholly closed, so it stays.
    const days = [c(Z('2026-11-12T00:00:00Z'), '100', '101', '99', '100.5'), c(Z('2026-11-14T00:00:00Z'), '100.5'), c(Z('2026-11-15T00:00:00Z'), '100.5'), c(Z('2026-11-16T00:00:00Z'), '100.5', '102', '100', '101')];
    const db = dbOf({ candles: async (_s, tf) => (tf === '1D' ? days : []) });
    const a = await make(new Map(), SUNDAY + 2 * 86_400_000, { network: 'testnet', chainId: 46630 }, { db });
    const view = (await a.inject('/v1/markets/TSLA/candles?tf=1D&limit=10&sessions=true')).json() as Candle[];
    expect(view.map((k) => k.t)).toEqual([Z('2026-11-12T00:00:00Z'), Z('2026-11-14T00:00:00Z'), Z('2026-11-16T00:00:00Z')]);
  });
});
