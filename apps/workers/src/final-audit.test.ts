/**
 * Regression tests for the final backend audit (2026-11-15, workers side): F-1 the candle-source
 * migration must never cost real history, F-4 a conservative backfill, F-5 multiplier expiry and
 * pendingMultiplier, F-6 quotes after a lost snapshot, F-8 the prune index. The auditor's probes are W1
 * (workers-final-probe.test.ts), W2 and W3 (migration-backfill.sh).
 *
 * The Postgres tests need TEST_DATABASE_URL (a scratch database; skipped otherwise). Each one works in
 * a schema of its own that it creates and drops, and applies the real migrations with the Prisma CLI,
 * the way deploy/release.sh does, so the upgrade from the release before the column is replayed exactly.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheKeys, type MarketSnapshot, type Timeframe } from '@velum/config';
import { Prisma, PrismaClient } from '@velum/db';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { openJson, testMac } from './__fixtures__/mac';
import { loadLastTickPrices, loadSeries, prepareHistory, resetHistoryOnSourceChange, retagUnknownCandles, upsertMarkets } from './bootstrap';
import { seriesKey, type WorkerContext } from './context';
import { runPriceRelay } from './jobs/price-relay';
import { runPrune } from './jobs/prune';
import { bucketStart, candleUpsertSql } from './lib/candles';
import type { Logger } from './lib/log';
import { quoteConfirmed } from './lib/snapshot';
import { RH_ASSETS_RETRY_MS, RH_MULTIPLIER_MAX_AGE_MS, jumpGuard, rhMid, rhMultipliers, robinhoodSource, type RhQuote } from './sources';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const TSLA_ADDR = '0x322F0929c4625eD5bAd873c95208D54E1c003b2d';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TFS: Timeframe[] = ['15m', '1h', '4h', '1D'];

// ── F-5: multipliers ──────────────────────────────────────────────────────────

describe('F-5: the /rhj/assets multiplier table expires, and a pending multiplier refuses the fallback', () => {
  const assetsResponse = (over: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ assets: [{ tokenSymbol: 'TSLA', currentMultiplier: '1.000000000000000000', pendingMultiplier: '', deployments: [{ chainId: 4663, contractAddress: TSLA_ADDR }], ...over }] }), { status: 200 });
  const quote = (bid: string, ask: string, at: number): RhQuote => ({ tokenSymbol: 'TSLA', bid, ask, generatedAt: new Date(at).toISOString(), deployments: [{ chainId: 4663, contractAddress: TSLA_ADDR }] });

  it('W2: after a day of failed refreshes the table is refused, so a 2:1 split is never priced with the old multiplier', async () => {
    let fail = false;
    const fetchImpl = (async () => {
      if (fail) throw new Error('down');
      return assetsResponse();
    }) as unknown as typeof fetch;
    const mult = rhMultipliers(silent, fetchImpl);
    const t0 = Date.UTC(2026, 10, 16, 15);
    expect(await mult('TSLA', t0)).toBe('1.000000000000000000');
    fail = true;
    expect(await mult('TSLA', t0 + RH_MULTIPLIER_MAX_AGE_MS - RH_ASSETS_RETRY_MS)).toBe('1.000000000000000000'); // within a day: still used
    const later = t0 + 7 * DAY;
    expect(await mult('TSLA', later)).toBeNull();
    // The auditor's split: raw bid/ask halve while the real currentMultiplier became 2. No price at all.
    const accept = jumpGuard();
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const at = later + i * 2000;
      const mid = rhMid('TSLA', quote('199.9', '200.1', at), at, await mult('TSLA', at));
      seen.push(mid === null ? 'unusable' : accept('TSLA', mid, '400') ? 'accepted' : 'held');
    }
    expect(seen).toEqual(['unusable', 'unusable', 'unusable', 'unusable']);
    // The API answers again: the table is fresh and used.
    fail = false;
    expect(await mult('TSLA', later + RH_ASSETS_RETRY_MS + 1)).toBe('1.000000000000000000');
  });

  it('reads pendingMultiplier: a change announced refuses bid/ask x currentMultiplier; "" or the same value does not', async () => {
    const t = Date.UTC(2026, 10, 16, 15);
    const lookup = async (pendingMultiplier: unknown) => rhMultipliers(silent, (async () => assetsResponse({ pendingMultiplier })) as unknown as typeof fetch)('TSLA', t);
    expect(await lookup('')).toBe('1.000000000000000000');
    expect(await lookup(undefined)).toBe('1.000000000000000000');
    expect(await lookup(null)).toBe('1.000000000000000000');
    expect(await lookup('1.0')).toBe('1.000000000000000000'); // the same multiplier, written differently
    expect(await lookup('2.000000000000000000')).toBeNull();
    expect(await lookup('soon')).toBeNull(); // unreadable: assume a change
  });

  it('tokenBid/tokenAsk (adjusted by Robinhood) never need the table, even while it is refused', async () => {
    const now = Date.UTC(2026, 10, 16, 15);
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith('/rhj/assets')) return assetsResponse({ pendingMultiplier: '2' });
      if (!String(url).endsWith('/TSLA')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ quotes: [{ ...quote('399', '401', now - 1000), tokenBid: '399', tokenAsk: '401' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(Object.fromEntries(await robinhoodSource(silent, fetchImpl).read(new Map(), now))).toEqual({ TSLA: '400' });
    expect(calls.some((u) => u.endsWith('/rhj/assets'))).toBe(false);
  });
});

// ── F-6: quotes after a lost snapshot ─────────────────────────────────────────

describe('F-6: after a lost snapshot a frozen quote is not live, and the first quote meets the jump guard', () => {
  const OPEN = Date.UTC(2026, 10, 16, 15, 0, 0);
  function fakeRedis() {
    const store = new Map<string, string>();
    return {
      store,
      pipeline() {
        const ops: Array<[string, string]> = [];
        return {
          set(k: string, v: string) {
            ops.push([k, v]);
            return this;
          },
          async exec() {
            for (const [k, v] of ops) store.set(k, v);
            return [];
          },
        };
      },
    };
  }
  function relay(prices: () => Map<string, string>, over: Partial<WorkerContext> = {}) {
    const redis = fakeRedis();
    const ctx = {
      env: { pricePollMs: 2000 } as WorkerContext['env'],
      prisma: { priceTick: { createMany: async () => ({ count: 1 }), findFirst: async () => null } } as unknown as PrismaClient,
      redis: redis as unknown as Redis,
      log: silent,
      source: { name: 'robinhood', read: async () => prices() },
      marketIds: new Map([['TSLA', 'm1']]),
      snapshots: new Map<string, MarketSnapshot>(),
      open24h: new Map(),
      lastOpenRefresh: 0,
      series: new Map(),
      lastTickAt: new Map(),
      mac: testMac,
      enqueueCandles: async () => {},
      ...over,
    } as WorkerContext;
    const stored = () => openJson<MarketSnapshot>(redis.store.get(cacheKeys.price('TSLA')), cacheKeys.price('TSLA'));
    return { ctx, stored };
  }

  it('no previous snapshot: unconfirmed until the quote changes, then live with a fresh quote time', async () => {
    let price = '391.5';
    const { ctx, stored } = relay(() => new Map([['TSLA', price]]));
    await runPriceRelay(ctx, OPEN);
    expect(stored()).toMatchObject({ price: '391.5', updatedAt: OPEN, unconfirmed: true });
    await runPriceRelay(ctx, OPEN + 10 * MIN); // still the same quote
    expect(stored()).toMatchObject({ updatedAt: OPEN, checkedAt: OPEN + 10 * MIN, unconfirmed: true });
    price = '391.6';
    await runPriceRelay(ctx, OPEN + 11 * MIN);
    const s = stored()!;
    expect(s).toMatchObject({ price: '391.6', updatedAt: OPEN + 11 * MIN });
    expect(s.unconfirmed).toBeUndefined();
    // Once confirmed, an unchanged quote keeps its quote time and stays confirmed (frozen after 15 min).
    await runPriceRelay(ctx, OPEN + 12 * MIN);
    expect(stored()).toMatchObject({ updatedAt: OPEN + 11 * MIN });
    expect(stored()!.unconfirmed).toBeUndefined();
  });

  it('a previous snapshot (read back from Redis on start) carries its state; demo and dated quotes are confirmed', () => {
    const prev: MarketSnapshot = { symbol: 'TSLA', price: '391.5', mark: '391.6', open24h: '390', spark: ['391.5'], source: 'robinhood', updatedAt: OPEN - HOUR, checkedAt: OPEN - 1000 };
    expect(quoteConfirmed(prev, '391.5', 'robinhood')).toBe(true);
    expect(quoteConfirmed({ ...prev, unconfirmed: true }, '391.5', 'robinhood')).toBe(false);
    expect(quoteConfirmed({ ...prev, unconfirmed: true }, '391.7', 'robinhood')).toBe(true);
    expect(quoteConfirmed(undefined, '391.5', 'robinhood')).toBe(false);
    expect(quoteConfirmed({ ...prev, source: 'chainlink' }, '391.5', 'robinhood')).toBe(false);
    expect(quoteConfirmed(undefined, '391.5', 'demo')).toBe(true);
    expect(quoteConfirmed(undefined, '391.5', 'chainlink', OPEN - 5000)).toBe(true);
  });

  it('without a snapshot, the first quote is checked against the newest stored tick (a 50% jump is held)', async () => {
    const quotes = [200, 200.1, 199.9, 200];
    let i = 0;
    const now = OPEN;
    const fetchImpl = (async (url: string) => {
      if (!String(url).endsWith('/TSLA')) return new Response('{}', { status: 404 });
      const p = quotes[Math.min(i, quotes.length - 1)]!;
      return new Response(JSON.stringify({ quotes: [{ tokenSymbol: 'TSLA', deployments: [{ chainId: 4663, contractAddress: TSLA_ADDR }], bid: String(p - 0.1), ask: String(p + 0.1), tokenBid: String(p - 0.1), tokenAsk: String(p + 0.1), generatedAt: new Date(now + i * 2000 - 500).toISOString() }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const source = robinhoodSource(silent, fetchImpl);
    const { ctx, stored } = relay(() => new Map(), { source, lastTickPrice: new Map([['TSLA', '400']]) });
    const seen: Array<string | null> = [];
    for (; i < quotes.length; i++) {
      await runPriceRelay(ctx, now + i * 2000);
      seen.push(stored()?.price ?? null);
    }
    // Held twice, accepted on the third agreeing quote (RH_JUMP_CONFIRMATIONS), as with a snapshot.
    expect(seen).toEqual([null, null, '199.9', '200']);
    // Without the stored tick the same first quote would have been accepted at once.
    i = 0;
    const blind = relay(() => new Map(), { source: robinhoodSource(silent, fetchImpl) });
    await runPriceRelay(blind.ctx, now);
    expect(blind.stored()?.price).toBe('200');
  });
});

// ── Postgres: the upgrade path ────────────────────────────────────────────────

const DB_PKG = join(__dirname, '..', '..', '..', 'packages', 'db');
const MIGRATIONS = join(DB_PKG, 'prisma', 'migrations');
const PRISMA_CLI = join(DB_PKG, 'node_modules', 'prisma', 'build', 'index.js');
const INIT = '20261114000000_init';
const CANDLE_SOURCE = '20261115000000_candle_source';
const ALL = '99999999999999';

/** `prisma migrate deploy` with the repository's migrations up to `upTo` (inclusive), into `url`. */
function migrate(url: string, upTo: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'velum-mig-'));
  try {
    cpSync(join(DB_PKG, 'prisma', 'schema.prisma'), join(dir, 'schema.prisma'));
    mkdirSync(join(dir, 'migrations'));
    cpSync(join(MIGRATIONS, 'migration_lock.toml'), join(dir, 'migrations', 'migration_lock.toml'));
    for (const m of readdirSync(MIGRATIONS).filter((n) => /^\d{14}_/.test(n) && n <= upTo)) cpSync(join(MIGRATIONS, m), join(dir, 'migrations', m), { recursive: true });
    const r = spawnSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy', '--schema', join(dir, 'schema.prisma')], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: url, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (r.status !== 0) throw new Error(`prisma migrate deploy failed:\n${r.stdout}\n${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A scratch schema in TEST_DATABASE_URL's database, with a client on it; dropped by the returned cleanup. */
async function scratch(): Promise<{ url: string; prisma: PrismaClient; drop: () => Promise<void> }> {
  const name = `velum_f1_${randomBytes(4).toString('hex')}`;
  const u = new URL(process.env.TEST_DATABASE_URL!);
  u.searchParams.set('schema', name);
  const prisma = new PrismaClient({ datasources: { db: { url: u.toString() } } });
  return {
    url: u.toString(),
    prisma,
    drop: async () => {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      await prisma.$disconnect();
    },
  };
}

/** The candle upsert of the release before the source column (git 96c4864: apps/workers/src/lib/candles.ts). */
const oldReleaseUpsert = (marketId: string, at: number, price: string) => {
  const ts = (t: number) => new Date(t).toISOString().slice(0, -1);
  const values = TFS.map(
    (tf) =>
      Prisma.sql`(${marketId}, ${tf}, CAST(${ts(bucketStart(at, tf))} AS TIMESTAMP(3)), CAST(${price} AS DECIMAL(38,12)), CAST(${price} AS DECIMAL(38,12)), CAST(${price} AS DECIMAL(38,12)), CAST(${price} AS DECIMAL(38,12)))`,
  );
  return Prisma.sql`
    INSERT INTO "Candle" ("marketId", "tf", "t", "o", "h", "l", "c")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("marketId", "tf", "t") DO UPDATE SET
      "h" = GREATEST("Candle"."h", EXCLUDED."h"),
      "l" = LEAST("Candle"."l", EXCLUDED."l"),
      "c" = EXCLUDED."c"`;
};

/** One tick as the release before the column handled it: store the tick, then fold it into every timeframe. */
async function oldReleaseTick(prisma: PrismaClient, marketId: string, at: number, price: string): Promise<void> {
  await prisma.priceTick.create({ data: { marketId, price, source: 'robinhood', at: new Date(at) } });
  await prisma.$executeRaw(oldReleaseUpsert(marketId, at, price));
}

const priceAt = (i: number) => (390 + 5 * Math.sin(i / 7) + (i % 3) * 0.01).toFixed(2);

const redisStub = () => {
  const deleted: string[] = [];
  return { deleted, redis: { set: async () => 'OK', del: async (...k: string[]) => (deleted.push(...k), k.length) } as unknown as Redis };
};

const counts = async (prisma: PrismaClient) => {
  const rows = await prisma.$queryRaw<Array<{ source: string | null; n: bigint }>>`SELECT "source", count(*) AS n FROM "Candle" GROUP BY "source"`;
  return Object.fromEntries(rows.map((r) => [r.source ?? 'NULL', Number(r.n)]));
};

describe.skipIf(!process.env.TEST_DATABASE_URL)('F-1 on Postgres: upgrading from the release before Candle.source keeps all real history', () => {
  it('old schema with real candles -> migrate -> the old release writes a row -> this release starts: nothing deleted, history tagged and served', async () => {
    const { url, prisma, drop } = await scratch();
    try {
      // 1. The live server today: release 96c4864 on mainnet, schema of the first migration only.
      migrate(url, INIT);
      const ids = await upsertMarkets(prisma);
      const tsla = ids.get('TSLA')!;
      const t0 = bucketStart(Date.now() - 6 * HOUR, '1D') + 30 * MIN;
      const end = Date.now() - 2 * MIN;
      let n = 0;
      for (let at = t0; at < end; at += 5 * MIN) await oldReleaseTick(prisma, tsla, at, priceAt(n++));
      const before = await prisma.candle.count();
      expect(before).toBeGreaterThan(20);

      // 2. deploy.sh builds the new release and migrates, while the old release keeps running...
      migrate(url, ALL);
      // ...and handles one more tick: its candle upsert has no source column (NULL now, never 'demo').
      await oldReleaseTick(prisma, tsla, end + 60_000, '391.23');
      expect(await counts(prisma)).toEqual({ NULL: (await prisma.candle.count()) });
      const afterOld = await prisma.candle.count();

      // 3. This release starts on mainnet (PRICE_SOURCE=robinhood).
      const { redis, deleted } = redisStub();
      const { reset, tagged } = await prepareHistory(prisma, redis, 'robinhood', silent);
      expect(reset).toBe(false);
      expect(deleted).toEqual([]);
      expect(await prisma.candle.count()).toBe(afterOld); // nothing deleted
      expect(tagged).toBe(afterOld); // every candle is proven real by its ticks
      expect(await counts(prisma)).toEqual({ robinhood: afterOld });
      const series = await loadSeries(prisma, ids, 'robinhood');
      expect(TFS.reduce((a, tf) => a + series.get(seriesKey('TSLA', tf))!.length, 0)).toBe(afterOld);
      expect(series.get(seriesKey('TSLA', '15m'))!.at(-1)!.c).toBe(391230000000000000000n);
      // 4. Starting again changes nothing.
      expect(await prepareHistory(prisma, redis, 'robinhood', silent)).toEqual({ reset: false, tagged: 0 });
    } finally {
      await drop();
    }
  }, 60_000);

  it('the same, where 20261115000000_candle_source (DEFAULT demo) was applied on its own first: its demo defaults are not evidence', async () => {
    const { url, prisma, drop } = await scratch();
    try {
      migrate(url, INIT);
      const ids = await upsertMarkets(prisma);
      const tsla = ids.get('TSLA')!;
      // Ticks up to the current 15m bucket; the old release's tick after the migration opens it.
      const cut = bucketStart(Date.now(), '15m');
      let n = 0;
      for (let at = cut - 3 * HOUR; at < cut; at += 5 * MIN) await oldReleaseTick(prisma, tsla, at, priceAt(n++));
      migrate(url, CANDLE_SOURCE);
      await oldReleaseTick(prisma, tsla, cut, '391.23');
      // The trap the audit found: the old release's row is tagged 'demo' by that migration's default.
      expect((await counts(prisma)).demo).toBeGreaterThanOrEqual(1);
      const total = await prisma.candle.count();
      migrate(url, ALL);
      expect(await counts(prisma)).toEqual({ NULL: total });
      const { reset } = await prepareHistory(prisma, redisStub().redis, 'robinhood', silent);
      expect(reset).toBe(false);
      expect(await counts(prisma)).toEqual({ robinhood: total });
    } finally {
      await drop();
    }
  }, 60_000);

  it('W1: this release ran, deploy.sh switched back to the old release, then this release again: history kept', async () => {
    const { url, prisma, drop } = await scratch();
    try {
      migrate(url, ALL);
      const ids = await upsertMarkets(prisma);
      const tsla = ids.get('TSLA')!;
      // This release on mainnet: ticks and their candles, tagged robinhood.
      const t0 = Date.now() - 2 * HOUR;
      let n = 0;
      for (let at = t0; at < Date.now() - 20 * MIN; at += 5 * MIN) {
        const price = priceAt(n++);
        await prisma.priceTick.create({ data: { marketId: tsla, price, source: 'robinhood', at: new Date(at) } });
        await prisma.$executeRaw(candleUpsertSql(TFS.map((tf) => ({ marketId: tsla, tf, t: bucketStart(at, tf), price })), { source: 'robinhood' }));
      }
      // Rolled back: the old release opens a new 15m bucket without the column.
      await oldReleaseTick(prisma, tsla, Date.now() - MIN, '391.23');
      const total = await prisma.candle.count();
      expect((await counts(prisma)).NULL).toBeGreaterThanOrEqual(1);
      const { reset } = await prepareHistory(prisma, redisStub().redis, 'robinhood', silent);
      expect(reset).toBe(false);
      expect(await counts(prisma)).toEqual({ robinhood: total });
    } finally {
      await drop();
    }
  }, 60_000);

  it('W3 (F-4): demo-seeded candles without ticks, then real ticks: never tagged real, never served on mainnet, never deleted', async () => {
    const { url, prisma, drop } = await scratch();
    try {
      migrate(url, INIT);
      const ids = await upsertMarkets(prisma);
      const tsla = ids.get('TSLA')!;
      // The old release with PRICE_SOURCE=demo seeded 300 candles per timeframe (ending at the current
      // bucket) and stopped before its first tick.
      const now = Date.now();
      const seeded = TFS.flatMap((tf) =>
        Array.from({ length: 300 }, (_, i) => {
          const t = bucketStart(now, tf) - i * { '15m': 15 * MIN, '1h': HOUR, '4h': 4 * HOUR, '1D': DAY }[tf];
          const o = (300 + (i % 17)).toFixed(2);
          return Prisma.sql`(${tsla}, ${tf}, CAST(${new Date(t).toISOString().slice(0, -1)} AS TIMESTAMP(3)), CAST(${o} AS DECIMAL(38,12)), CAST(${'330.11'} AS DECIMAL(38,12)), CAST(${'280.07'} AS DECIMAL(38,12)), CAST(${o} AS DECIMAL(38,12)))`;
        }),
      );
      await prisma.$executeRaw`INSERT INTO "Candle" ("marketId", "tf", "t", "o", "h", "l", "c") VALUES ${Prisma.join(seeded)}`;
      // The operator switched to PRICE_SOURCE=robinhood (the old reset saw no demo tick); real ticks land
      // in the seeded current buckets.
      for (const [i, p] of ['391.2', '392.4', '390.8'].entries()) await oldReleaseTick(prisma, tsla, now - 3 * 1000 + i * 1000, p);
      const total = await prisma.candle.count();
      migrate(url, ALL);
      const { reset, tagged } = await prepareHistory(prisma, redisStub().redis, 'robinhood', silent);
      expect(reset).toBe(false);
      expect(tagged).toBe(0); // the mixed current buckets included: their open is a seeded value
      expect(await counts(prisma)).toEqual({ NULL: total });
      expect(await prisma.candle.count({ where: { source: { in: ['robinhood', 'chainlink'] } } })).toBe(0); // the mainnet API's filter
      const series = await loadSeries(prisma, ids, 'robinhood');
      expect(TFS.map((tf) => series.get(seriesKey('TSLA', tf))!.length)).toEqual([0, 0, 0, 0]);
    } finally {
      await drop();
    }
  }, 60_000);
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('F-1, F-4, F-6, F-8 on Postgres: the proof rules, the reset evidence, last tick prices, the prune index', () => {
  it('tags a NULL candle only when its ticks are all of one kind and its open, close, high and low come from them', async () => {
    const { url, prisma, drop } = await scratch();
    try {
      migrate(url, ALL);
      const ids = await upsertMarkets(prisma);
      const m = ids.get('TSLA')!;
      const base = bucketStart(Date.now() - 10 * HOUR, '1h');
      const at = (bucket: number, k: number) => new Date(base + bucket * HOUR + k * MIN);
      const ticks: Array<[number, string, string]> = [];
      const candle = (bucket: number, o: string, h: string, l: string, c: string, source: string | null = null) => ({ marketId: m, tf: '1h', t: new Date(base + bucket * HOUR), o, h, l, c, source });
      const put = (bucket: number, source: string, prices: string[]) => {
        for (const p of prices) ticks.push([bucket, source, p]);
      };
      put(1, 'robinhood', ['100', '105', '98', '101']); // proven robinhood
      put(2, 'oracle', ['100', '101']); // Chainlink ticks
      put(3, 'demo', ['50', '51']); // demo
      put(4, 'demo', ['100']);
      put(4, 'robinhood', ['101']); // two kinds in one bucket
      put(5, 'robinhood', ['100', '105']); // high above every stored tick (a missing tick)
      put(6, 'robinhood', ['100', '105']); // open is no tick (a seeded open)
      put(8, 'demo', ['100']); // already tagged: left alone
      let k = 0;
      await prisma.priceTick.createMany({ data: ticks.map(([b, source, price]) => ({ marketId: m, source, price, at: at(b, k++ % 50) })) });
      await prisma.candle.createMany({
        data: [
          candle(0, '1', '1', '1', '1'), // before the oldest tick: never examined
          candle(1, '100', '105', '98', '101'),
          candle(2, '100', '101', '100', '101'),
          candle(3, '50', '51', '50', '51'),
          candle(4, '100', '101', '100', '101'),
          candle(5, '100', '110', '100', '105'),
          candle(6, '99', '105', '99', '105'),
          candle(7, '1', '1', '1', '1'), // no ticks
          candle(8, '100', '100', '100', '100', 'robinhood'),
        ],
      });
      expect(await retagUnknownCandles(prisma, silent)).toBe(3);
      const rows = await prisma.candle.findMany({ where: { marketId: m }, orderBy: { t: 'asc' }, select: { source: true } });
      expect(rows.map((r) => r.source)).toEqual([null, 'robinhood', 'chainlink', 'demo', null, null, null, null, 'robinhood']);
    } finally {
      await drop();
    }
  }, 60_000);

  it('resets only on positive evidence: NULL candles never, a demo-tagged candle or a demo tick does', async () => {
    const { url, prisma, drop } = await scratch();
    try {
      migrate(url, ALL);
      const ids = await upsertMarkets(prisma);
      const m = ids.get('TSLA')!;
      const t = new Date(bucketStart(Date.now() - DAY, '1h'));
      await prisma.candle.create({ data: { marketId: m, tf: '1h', t, o: '1', h: '1', l: '1', c: '1' } });
      await prisma.priceTick.create({ data: { marketId: m, price: '1', source: 'robinhood', at: new Date() } });
      expect(await resetHistoryOnSourceChange(prisma, redisStub().redis, 'robinhood', silent)).toBe(false);
      expect(await resetHistoryOnSourceChange(prisma, redisStub().redis, 'chainlink', silent)).toBe(false); // real to real
      await prisma.candle.create({ data: { marketId: m, tf: '4h', t, o: '1', h: '1', l: '1', c: '1', source: 'demo' } });
      expect(await resetHistoryOnSourceChange(prisma, redisStub().redis, 'robinhood', silent)).toBe(true);
      expect(await prisma.candle.count()).toBe(0);
      // Demo source: robinhood ticks are evidence; NULL candles are not.
      await prisma.candle.create({ data: { marketId: m, tf: '1h', t, o: '1', h: '1', l: '1', c: '1' } });
      await prisma.priceTick.deleteMany({});
      expect(await resetHistoryOnSourceChange(prisma, redisStub().redis, 'demo', silent)).toBe(false);
      await prisma.priceTick.create({ data: { marketId: m, price: '1', source: 'robinhood', at: new Date() } });
      expect(await resetHistoryOnSourceChange(prisma, redisStub().redis, 'demo', silent)).toBe(true);
    } finally {
      await drop();
    }
  }, 60_000);

  it('F-6: loadLastTickPrices reads the newest tick of the current source; F-8: the prune deletes through the index on "at"', async () => {
    const { url, prisma, drop } = await scratch();
    try {
      migrate(url, ALL);
      const ids = await upsertMarkets(prisma);
      const m = ids.get('TSLA')!;
      const now = Date.now();
      await prisma.priceTick.createMany({
        data: [
          { marketId: m, price: '390', source: 'robinhood', at: new Date(now - 10 * DAY) },
          { marketId: m, price: '391.5', source: 'robinhood', at: new Date(now - 5000) },
          { marketId: m, price: '12', source: 'demo', at: new Date(now - 1000) },
          { marketId: m, price: '1', source: 'robinhood', at: new Date(now + HOUR) }, // dated ahead
        ],
      });
      expect(Object.fromEntries(await loadLastTickPrices(prisma, ids, 'robinhood', now))).toEqual({ TSLA: '391.5' });
      expect(Object.fromEntries(await loadLastTickPrices(prisma, ids, 'demo', now))).toEqual({ TSLA: '12' });
      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN DELETE FROM "PriceTick" WHERE "at" < now() - interval '7 days'`);
      });
      expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain('PriceTick_at_idx');
      const ctx = { prisma, env: { tickRetentionDays: 7 }, log: silent } as unknown as WorkerContext;
      expect(await runPrune(ctx, now)).toBe(1);
    } finally {
      await drop();
    }
  }, 60_000);
});
