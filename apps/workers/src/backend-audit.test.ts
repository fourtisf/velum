/**
 * Regression tests for the full backend audit of 2026-11-15 (M-1, M-2, M-3, L-1, L-6, I-1, I-5, I-7,
 * CC-05, mainnet price source). The fixtures in __fixtures__ are real api.robinhood.com/rhj responses
 * captured on Sunday 2026-11-15 (US market closed: bid/ask frozen, generatedAt = response time).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_FUTURE_SKEW_MS, TIMEFRAMES, cacheKeys, type MarketSnapshot } from '@velum/config';
import type { PrismaClient } from '@velum/db';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { dropFutureHistory, loadLastTickAt, loadSeries, loadSnapshots } from './bootstrap';
import { seriesKey, type CandleJobData, type WorkerContext } from './context';
import { loadEnv } from './env';
import { CANDLE_JOB_MAX_AGE_MS, candleJobFromTicks, runCandles } from './jobs/candles';
import { runPriceRelay } from './jobs/price-relay';
import { startChainCheck } from './lib/chain';
import { bucketStart, toCandle, type WadCandle } from './lib/candles';
import type { Logger } from './lib/log';
import { redact, secretValues } from './lib/redact';
import { retryForever } from './lib/retry';
import { quoteTime } from './lib/snapshot';
import { chainlinkSource, jumpGuard, rhMid, rhTokenBidAsk, robinhoodSource, type RhQuote } from './sources';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8'));
const sunday = fixture('rh-tsla-sunday.json') as { quotes: RhQuote[] };
const aapl = fixture('rh-aapl-sunday.json') as { quotes: RhQuote[] };
const assets = fixture('rh-assets-sample.json');

function fakeRedis(store = new Map<string, string>()) {
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
    async set(k: string, v: string) {
      store.set(k, v);
      return 'OK';
    },
    async mget(...keys: string[]) {
      return keys.map((k) => store.get(k) ?? null);
    },
  };
}

// ── M-1: frozen quotes keep their quote time ──────────────────────────────────

describe('M-1: snapshots are stamped with the quote time, not the poll time', () => {
  const t0 = Date.parse(sunday.quotes[0]!.generatedAt!);

  function relayCtx(fetchImpl: typeof fetch, snapshots = new Map<string, MarketSnapshot>()) {
    const redis = fakeRedis();
    return {
      redis,
      ctx: {
        env: { pricePollMs: 60_000 } as WorkerContext['env'],
        prisma: { priceTick: { createMany: async () => ({ count: 1 }), findFirst: async () => null } } as unknown as PrismaClient,
        redis: redis as unknown as Redis,
        log: silent,
        source: robinhoodSource(silent, fetchImpl),
        marketIds: new Map([['TSLA', 'm1']]),
        snapshots,
        open24h: new Map(),
        lastOpenRefresh: 0,
        series: new Map(),
        lastTickAt: new Map(),
        enqueueCandles: async () => {},
      } as WorkerContext,
    };
  }

  it('48 h of the real Sunday quote (frozen bid/ask, fresh generatedAt) keep updatedAt at the first reading', async () => {
    let now = t0;
    const fetchImpl = (async (url: string) => {
      if (!String(url).endsWith('/TSLA')) return new Response('{}', { status: 404 });
      const q = { ...sunday.quotes[0], generatedAt: new Date(now - ((now - t0) % 30_000)).toISOString() };
      return new Response(JSON.stringify({ quotes: [q] }), { status: 200 });
    }) as typeof fetch;
    const { ctx, redis } = relayCtx(fetchImpl);
    for (now = t0; now < t0 + 48 * 3_600_000; now += 60_000) await runPriceRelay(ctx, now);
    const last = now - 60_000;
    const snap = JSON.parse(redis.store.get(cacheKeys.price('TSLA'))!) as MarketSnapshot;
    expect(snap.price).toBe('390.915');
    expect(snap.updatedAt).toBe(t0); // quote time: 48 h old, so the API reports it stale
    expect(snap.checkedAt).toBe(last); // the pipeline itself is alive
  });

  it('a quote that moves gets a new quote time; a restart keeps the old one while the price is unchanged', () => {
    const prev: MarketSnapshot = { symbol: 'TSLA', price: '390.915', mark: '391.07', open24h: '390', spark: ['390.915'], source: 'robinhood', updatedAt: t0, checkedAt: t0 + 5000 };
    expect(quoteTime(prev, '390.915', 'robinhood', t0 + 3_600_000)).toBe(t0);
    expect(quoteTime(prev, '391', 'robinhood', t0 + 3_600_000)).toBe(t0 + 3_600_000);
    expect(quoteTime(undefined, '391', 'robinhood', t0)).toBe(t0);
    expect(quoteTime({ ...prev, source: 'demo' }, '390.915', 'robinhood', t0 + 1000)).toBe(t0 + 1000);
    expect(quoteTime(prev, '390.915', 'demo', t0 + 1000)).toBe(t0 + 1000);
    // A source that dates its quotes (a Chainlink round) is used as is, never ahead of now.
    expect(quoteTime(prev, '390.915', 'chainlink', t0 + 60_000, t0 + 30_000)).toBe(t0 + 30_000);
    expect(quoteTime(prev, '390.915', 'chainlink', t0 + 60_000, t0 + 90_000)).toBe(t0 + 60_000);
  });

  it('a flood of price jobs cannot poll the upstream faster than half the poll interval (M-2)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;
    const { ctx } = relayCtx(fetchImpl);
    ctx.env = { pricePollMs: 2000 } as WorkerContext['env'];
    for (let i = 0; i < 50; i++) await runPriceRelay(ctx, t0 + i * 10);
    expect(calls).toBe(10); // one poll (10 markets); the other 49 runs within 1 s are skipped
    await runPriceRelay(ctx, t0 + 1000);
    expect(calls).toBe(20);
  });
});

// ── I-1, CC-05: Robinhood quote parsing ───────────────────────────────────────

describe('I-1: a midpoint that rounds to 0 is rejected, and the jump guard never divides by zero', () => {
  const now = Date.parse('2026-11-16T15:00:00Z');
  const q = { ...sunday.quotes[0]!, generatedAt: new Date(now - 1000).toISOString() };
  it('rejects bid = ask = 0.00004 (W4)', () => {
    expect(rhMid('TSLA', { ...q, tokenBid: '0.00004', tokenAsk: '0.00004' }, now)).toBeNull();
    expect(rhMid('TSLA', { ...q, tokenBid: '0.0001', tokenAsk: '0.0001' }, now)).toBe('0.0001');
  });
  it('treats a zero or negative candidate as unacceptable instead of throwing', () => {
    const g = jumpGuard();
    expect(() => [g('TSLA', '0', '391.65'), g('TSLA', '0', '391.65'), g('TSLA', '0', '391.65')]).not.toThrow();
    expect(g('TSLA', '0', '391.65')).toBe(false);
    expect(g('TSLA', '0', undefined)).toBe(false);
  });
});

describe('CC-05: without tokenBid/tokenAsk, bid/ask x currentMultiplier from /rhj/assets', () => {
  const real = aapl.quotes[0]!;
  const now = Date.parse(real.generatedAt!) + 1000;
  const multiplier = (assets.assets as Array<{ tokenSymbol: string; currentMultiplier: string }>).find((a) => a.tokenSymbol === 'AAPL')!.currentMultiplier;

  it('reproduces the undocumented tokenBid/tokenAsk from the documented fields (real AAPL quote, multiplier 1.0010906...)', () => {
    const { tokenBid, tokenAsk, ...documented } = real;
    expect(rhTokenBidAsk(documented, multiplier)!.map(String)).toEqual([tokenBid!.replace('.', ''), tokenAsk!.replace('.', '')]);
    expect(rhMid('AAPL', documented, now, multiplier)).toBe(rhMid('AAPL', real, now));
    expect(rhMid('AAPL', real, now)).toBe('355.287');
  });
  it('without tokenBid and without a multiplier the quote is unusable (never assumes 1)', () => {
    const { tokenBid: _b, tokenAsk: _a, ...documented } = real;
    expect(rhMid('AAPL', documented, now)).toBeNull();
    expect(rhMid('AAPL', documented, now, '0')).toBeNull();
    expect(rhMid('AAPL', documented, now, '5000')).toBeNull();
    expect(rhMid('AAPL', { ...real, tokenAsk: undefined }, now)).toBeNull();
  });
  it('the source reads /rhj/assets only when a quote lacks tokenBid, matched by the exact token address', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith('/rhj/assets')) return new Response(JSON.stringify(assets), { status: 200 });
      if (String(url).endsWith('/AAPL')) {
        const { tokenBid: _b, tokenAsk: _a, ...documented } = real;
        return new Response(JSON.stringify({ quotes: [{ ...documented, generatedAt: new Date(now - 1000).toISOString() }] }), { status: 200 });
      }
      if (String(url).endsWith('/TSLA')) return new Response(JSON.stringify({ quotes: [{ ...sunday.quotes[0], generatedAt: new Date(now - 1000).toISOString() }] }), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const src = robinhoodSource(silent, fetchImpl);
    const out = await src.read(new Map(), now);
    expect(Object.fromEntries(out)).toEqual({ AAPL: '355.287', TSLA: '390.915' });
    expect(calls.filter((u) => u.endsWith('/rhj/assets'))).toHaveLength(1);
    await src.read(new Map(out), now + 2000);
    expect(calls.filter((u) => u.endsWith('/rhj/assets'))).toHaveLength(1); // cached
  });
});

// ── L-1, M-2: candles ─────────────────────────────────────────────────────────

function candleCtx(ticks: Array<{ marketId: string; price: string; source: string; at: number }> = []) {
  const sql: string[] = [];
  const redis = fakeRedis();
  const ctx = {
    env: {} as WorkerContext['env'],
    prisma: {
      $executeRaw: async (q: { sql: string }) => (sql.push(q.sql), 1),
      $transaction: async (ops: unknown[]) => ops,
      priceTick: {
        findMany: async ({ where }: { where: { at: Date; marketId: { in: string[] }; source: string } }) =>
          ticks
            .filter((t) => t.at === where.at.getTime() && where.marketId.in.includes(t.marketId) && t.source === where.source)
            .map((t) => ({ marketId: t.marketId, price: { toFixed: () => t.price } })),
      },
    } as unknown as PrismaClient,
    redis: redis as unknown as Redis,
    log: silent,
    source: { name: 'robinhood', read: async () => new Map() },
    marketIds: new Map([
      ['TSLA', 'm-tsla'],
      ['AMZN', 'm-amzn'],
    ]),
    snapshots: new Map(),
    open24h: new Map(),
    lastOpenRefresh: 0,
    series: new Map<string, WadCandle[]>(),
    lastTickAt: new Map<string, number>(),
    enqueueCandles: async () => {},
  } as WorkerContext;
  return { ctx, sql, redis };
}

describe('L-1: a tick dated ahead never freezes the candles (W3)', () => {
  const T = Date.UTC(2026, 10, 16, 14, 0, 0);
  it('the +1 h tick is ignored and the next hour of real ticks all land in every timeframe', async () => {
    const { ctx } = candleCtx();
    await runCandles(ctx, { at: T, prices: { TSLA: '400' } }, T);
    expect(await runCandles(ctx, { at: T + 3_600_000, prices: { TSLA: '1' } }, T)).toBe(0); // one bad / ahead tick
    let applied = 0;
    for (let t = T + 2000; t < T + 3_600_000; t += 60_000) applied += await runCandles(ctx, { at: t, prices: { TSLA: String(400 + (t - T) / 60_000) } }, t);
    expect(applied).toBe(TIMEFRAMES.length * 60);
    const last15 = ctx.series.get(seriesKey('TSLA', '15m'))!.at(-1)!;
    expect(last15.t).toBe(bucketStart(T + 3_540_000, '15m'));
    expect(toCandle(last15).c).not.toBe('1');
    expect(ctx.lastTickAt.get('TSLA')).toBeLessThan(T + 3_600_000);
  });
  it('a tick within the clock-skew allowance still counts', async () => {
    const { ctx } = candleCtx();
    expect(await runCandles(ctx, { at: T + MAX_FUTURE_SKEW_MS, prices: { TSLA: '400' } }, T)).toBe(TIMEFRAMES.length);
  });
  it('prices must be positive decimals below 1e9', async () => {
    const { ctx } = candleCtx();
    expect(await runCandles(ctx, { at: T, prices: { TSLA: '0', AMZN: '1e9' } }, T)).toBe(0);
    expect(await runCandles(ctx, { at: T, prices: { TSLA: '-5', AMZN: '1000000000' } }, T)).toBe(0);
    expect(await runCandles(ctx, { at: T, prices: { TSLA: 'NaN', AMZN: '99999999' } }, T)).toBe(TIMEFRAMES.length);
  });
});

describe('M-2: a queued candle job is never trusted', () => {
  const T = Date.UTC(2026, 10, 16, 14, 0, 0);
  const tick = (marketId: string, price: string, at: number) => ({ marketId, price, source: 'robinhood', at });

  it('prices come from the ticks stored in Postgres at the job time, not from the payload', async () => {
    const { ctx } = candleCtx([tick('m-tsla', '391.5', T), tick('m-amzn', '233.4', T), tick('m-tsla', '1', T + 1)]);
    // An injected job (the e2e repro): bogus prices for a real tick time.
    const job = await candleJobFromTicks(ctx, { at: T, prices: { TSLA: '1.00', AMZN: '99999999' } }, T + 5000);
    expect(job).toEqual({ at: T, prices: { TSLA: '391.5', AMZN: '233.4' } });
  });

  it('drops jobs out of the time window, malformed or naming no stored tick', async () => {
    const { ctx } = candleCtx([tick('m-tsla', '391.5', T)]);
    const year = Date.UTC(2027, 10, 15, 12, 0, 0); // the e2e repro's job, a year ahead
    for (const bad of [{ at: year, prices: { TSLA: '1.00' } }, { at: T - CANDLE_JOB_MAX_AGE_MS - 1 }, { at: 'x' }, null, { at: T + 7 }, { at: 1.5 }]) {
      expect(await candleJobFromTicks(ctx, bad, T), JSON.stringify(bad)).toBeNull();
    }
    // Ticks of another source (cleared demo history) do not count either.
    const other = candleCtx([{ ...tick('m-tsla', '391.5', T), source: 'demo' }]);
    expect(await candleJobFromTicks(other.ctx, { at: T }, T)).toBeNull();
  });

  it('end to end: a forged job leaves Postgres, memory and the cache exactly as a replay of the real tick', async () => {
    const { ctx, redis } = candleCtx([tick('m-tsla', '391.5', T)]);
    const view = () => JSON.stringify([...ctx.series].map(([k, s]) => [k, s.map(toCandle)]));
    const real: CandleJobData = { at: T, prices: { TSLA: '391.5' } };
    await runCandles(ctx, real, T);
    const before = view();
    const forged = await candleJobFromTicks(ctx, { at: T, prices: { TSLA: '0.0001' } }, T + 1000);
    expect(forged).toEqual(real);
    await runCandles(ctx, forged!, T + 1000);
    expect(view()).toBe(before);
    for (const tf of TIMEFRAMES) expect(JSON.parse(redis.store.get(cacheKeys.candles('TSLA', tf))!).at(-1)).toMatchObject({ l: '391.5', c: '391.5' });
  });
});

describe('M-2: snapshots read back from Redis are validated', () => {
  const now = Date.UTC(2026, 10, 16, 14, 0, 0);
  const good: MarketSnapshot = { symbol: 'TSLA', price: '391.65', mark: '391.8', open24h: '390', spark: ['391.65'], source: 'robinhood', updatedAt: now - 1000, checkedAt: now - 500 };
  it('ignores future-dated, oversized, mislabelled or malformed entries', async () => {
    const r = fakeRedis();
    r.store.set(cacheKeys.price('TSLA'), JSON.stringify(good));
    r.store.set(cacheKeys.price('AMZN'), JSON.stringify({ ...good, symbol: 'AMZN', updatedAt: now + 10 * 365 * 86_400_000 }));
    r.store.set(cacheKeys.price('PLTR'), JSON.stringify({ ...good, symbol: 'PLTR', spark: Array.from({ length: 200_000 }, () => '1') }));
    r.store.set(cacheKeys.price('NFLX'), JSON.stringify({ ...good, symbol: 'TSLA' }));
    r.store.set(cacheKeys.price('AMD'), '{"price": "1"}');
    r.store.set(cacheKeys.price('NVDA'), JSON.stringify({ ...good, symbol: 'NVDA', price: '0' }));
    const out = await loadSnapshots(r as unknown as Redis, now);
    expect([...out.keys()]).toEqual(['TSLA']);
  });
});

// Needs TEST_DATABASE_URL pointing at a migrated database. Skipped otherwise.
describe.skipIf(!process.env.TEST_DATABASE_URL)('L-1, I-7 on Postgres: future rows dropped, series read by source', () => {
  it('dropFutureHistory, loadLastTickAt and loadSeries ignore rows dated ahead; loadSeries keeps only the current source', async () => {
    const { PrismaClient: Client } = await import('@velum/db');
    const prisma = new Client({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
    const now = Date.now();
    const hour = Math.floor(now / 3_600_000) * 3_600_000;
    try {
      const m = await prisma.market.upsert({ where: { symbol: 'ZZF' }, create: { symbol: 'ZZF', name: 'ZZF', status: 'live', maxLeverage: 5, takerFeeBps: 6 }, update: {}, select: { id: true } });
      await prisma.candle.deleteMany({ where: { marketId: m.id } });
      await prisma.priceTick.deleteMany({ where: { marketId: m.id } });
      const c = (t: number, source: string, price = '100') => ({ marketId: m.id, tf: '1h', t: new Date(t), o: price, h: price, l: price, c: price, source });
      await prisma.candle.createMany({ data: [c(hour - 3_600_000, 'robinhood'), c(hour, 'demo', '5'), c(hour + 365 * 86_400_000, 'robinhood', '1')] });
      await prisma.priceTick.createMany({ data: [{ marketId: m.id, price: '100', source: 'robinhood', at: new Date(now - 5000) }, { marketId: m.id, price: '1', source: 'robinhood', at: new Date(now + 3_600_000) }] });
      const ids = new Map([['ZZF', m.id]]);
      expect([...(await loadLastTickAt(prisma, ids, now))]).toEqual([['ZZF', now - 5000]]);
      const series = await loadSeries(prisma, ids, 'robinhood', now);
      expect(series.get(seriesKey('ZZF', '1h'))!.map((x) => x.t)).toEqual([hour - 3_600_000]);
      expect(await dropFutureHistory(prisma, silent, now)).toBeGreaterThanOrEqual(2);
      expect(await prisma.candle.count({ where: { marketId: m.id } })).toBe(2);
      expect(await prisma.priceTick.count({ where: { marketId: m.id } })).toBe(1);
    } finally {
      const m = await prisma.market.findUnique({ where: { symbol: 'ZZF' } });
      if (m) {
        await prisma.candle.deleteMany({ where: { marketId: m.id } });
        await prisma.priceTick.deleteMany({ where: { marketId: m.id } });
        await prisma.market.delete({ where: { id: m.id } });
      }
      await prisma.$disconnect();
    }
  });
});

// ── M-3: start-up retries ─────────────────────────────────────────────────────

describe('M-3: start-up waits for Postgres and Redis with backoff instead of exiting', () => {
  it('retries with growing waits until the dependency answers', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const out = await retryForever(
      'PostgreSQL',
      async () => {
        if (++attempts < 6) throw new Error("Can't reach database server at `127.0.0.1:5438`");
        return 'up';
      },
      silent,
      { initialMs: 1000, maxMs: 8000, sleep: async (ms) => void waits.push(ms) },
    );
    expect(out).toBe('up');
    expect(waits).toEqual([1000, 2000, 4000, 8000, 8000]);
  });
  it('stops waiting when the process is told to stop', async () => {
    const stop = new AbortController();
    const p = retryForever('Redis', async () => Promise.reject(new Error('ECONNREFUSED')), silent, { initialMs: 50, signal: stop.signal });
    setTimeout(() => stop.abort(), 20);
    await expect(p).rejects.toThrow();
  });
});

// ── I-5: chain id ─────────────────────────────────────────────────────────────

describe('I-5: RPC_URL must serve the configured chain', () => {
  const rpc = (result: string | Error) =>
    (async () => (result instanceof Error ? Promise.reject(result) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 }))) as unknown as typeof fetch;
  it('reports ok, mismatch, and keeps retrying (never throwing) while unreachable', async () => {
    const ok = startChainCheck('https://rpc.example', 46630, silent, { fetchImpl: rpc('0xb626') });
    await ok.done;
    expect(ok.state()).toBe('ok');
    const bad = startChainCheck('https://rpc.example', 46630, silent, { fetchImpl: rpc('0x1237') });
    await bad.done;
    expect(bad.state()).toBe('mismatch');
    const stop = new AbortController();
    const down = startChainCheck('https://rpc.example', 46630, silent, { fetchImpl: rpc(new Error('ECONNREFUSED')), retryMs: 5, signal: stop.signal });
    await new Promise((r) => setTimeout(r, 30));
    expect(down.state()).toBe('unknown');
    stop.abort();
    await down.done;
  });
  it('the Chainlink source reads nothing while the RPC serves another chain', async () => {
    let reads = 0;
    const client = { readContract: async () => (reads++, 8) } as never;
    const src = chainlinkSource('https://rpc.example', { TSLA: '0x0000000000000000000000000000000000000001' }, silent, client, () => false);
    expect((await src.read(new Map(), Date.now())).size).toBe(0);
    expect(reads).toBe(0);
  });
});

// ── env: mainnet price source, LOG_LEVEL, REDIS_URL socket ────────────────────

describe('env: mainnet never runs simulated prices; LOG_LEVEL and REDIS_URL are validated', () => {
  const base = { DATABASE_URL: 'postgresql://a', REDIS_URL: 'redis://b' };
  it('refuses PRICE_SOURCE=demo (or unset) with VELUM_NETWORK=mainnet', () => {
    for (const PRICE_SOURCE of ['demo', undefined]) {
      expect(() => loadEnv({ ...base, VELUM_NETWORK: 'mainnet', PRICE_SOURCE })).toThrow(/PRICE_SOURCE=demo \(the default\) is not allowed with VELUM_NETWORK=mainnet/);
    }
    try {
      loadEnv({ ...base, VELUM_NETWORK: 'mainnet', PRICE_SOURCE: 'robinhood' });
    } catch (err) {
      expect((err as Error).message).not.toMatch(/PRICE_SOURCE/); // only the testnet CHAIN_ID mismatch of this test process
    }
  });
  it('validates LOG_LEVEL against pino levels', () => {
    expect(() => loadEnv({ ...base, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent/);
    expect(loadEnv({ ...base, LOG_LEVEL: 'warn' })).toBeTruthy();
  });
  it('accepts the dedicated Redis socket URL of deploy/redis-velum.sh', () => {
    expect(loadEnv({ ...base, REDIS_URL: 'unix://:0123abcd0123abcd@/run/velum-redis/redis.sock' }).redis).toEqual({ path: '/run/velum-redis/redis.sock', db: 0, password: '0123abcd0123abcd' });
    expect(loadEnv({ ...base, REDIS_URL: 'redis://:p%40ss@127.0.0.1:6379/5' }).redis).toEqual({ host: '127.0.0.1', port: 6379, db: 5, password: 'p@ss' });
    expect(() => loadEnv({ ...base, REDIS_URL: 'unix://relative/redis.sock' })).toThrow(/REDIS_URL/);
    expect(() => loadEnv({ ...base, REDIS_URL: 'http://127.0.0.1:6379' })).toThrow(/REDIS_URL must be a redis:\/\/, rediss:\/\/ or unix:\/\/ URL/);
  });
});

// ── L-6: secrets are redacted as values ───────────────────────────────────────

describe('L-6: the actual secret values are redacted, wherever they appear', () => {
  // The auditor's probe (redact-probe.ts): characters that end a URL early leaked the rest of it.
  const cases = ['s3cr3t pass', 's3cr3t"pass', 's3cr3t<pass>', 's3cr3t`pass', 'pa%20ss word', 'Pässwört€'];
  it.each(cases)('password %j never survives', (pw) => {
    const env = { REDIS_URL: `redis://:${pw}@127.0.0.1:6379/5`, DATABASE_URL: `postgresql://velum:${pw}@127.0.0.1:5432/velum` };
    for (const tpl of [`Error: connect redis://:${pw}@127.0.0.1:6379/5 failed`, `DATABASE_URL=postgresql://velum:${pw}@127.0.0.1:5432/velum`, `auth failed for "${pw}"`]) {
      const out = redact(tpl, env);
      for (const frag of ['pass', 'word', 'rt€', 's3cr3t']) if (pw.includes(frag)) expect(out, out).not.toContain(frag);
    }
  });
  it('removes PROXY_SECRET, private keys, socket passwords and RPC keys', () => {
    const env = {
      PROXY_SECRET: 'ab'.repeat(32),
      PRICE_RELAY_PRIVATE_KEY: '0x' + 'cd'.repeat(32),
      REDIS_URL: 'unix://:feedfacefeedface@/run/velum-redis/redis.sock',
      RPC_URL: 'https://robinhood-mainnet.g.alchemy.com/v2/AlchemyKeyAbc123',
    };
    expect(secretValues(env)).toEqual(expect.arrayContaining([env.PROXY_SECRET, env.PRICE_RELAY_PRIVATE_KEY, 'feedfacefeedface', 'AlchemyKeyAbc123']));
    const msg = `proxy ${env.PROXY_SECRET} key ${env.PRICE_RELAY_PRIVATE_KEY} redis feedfacefeedface rpc key AlchemyKeyAbc123`;
    expect(redact(msg, env)).toBe('proxy *** key *** redis *** rpc key ***');
    expect(redact('short values like 5 or "v2" are kept', { RPC_URL: 'https://h/v2/x', PROXY_SECRET: 'abc' })).toBe('short values like 5 or "v2" are kept');
  });
});
