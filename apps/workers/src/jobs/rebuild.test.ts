/**
 * Real history hidden on mainnet after the source column (owner report of 2026-11-15): candles written before the
 * column are NULL (unknown) and mainnet serves only tagged ones. The re-tag proof (retagUnknownCandlesSql) needs a
 * candle to match its stored ticks exactly; the rebuild (jobs/rebuild.ts) recomputes such candles from the ticks.
 *
 * Needs TEST_DATABASE_URL (a migrated scratch database). Skipped otherwise.
 */
import { CANDLE_CACHE_SIZE, TIMEFRAMES, TIMEFRAME_MS, type Timeframe } from '@velum/config';
import { Prisma, type PrismaClient } from '@velum/db';
import { parseWad, wmax, wmin, type Wad } from '@velum/math';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { retagUnknownCandlesSql } from '../bootstrap';
import { rebuildCandlesFromTicks } from './rebuild';

const DB = process.env.TEST_DATABASE_URL;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

/* ---------- The candle builder of 96c4864 (apps/workers/src/lib/candles.ts, jobs/candles.ts), verbatim in logic ---------- */
interface OldCandle {
  t: number;
  o: Wad;
  h: Wad;
  l: Wad;
  c: Wad;
}
function oldApplyTick(series: OldCandle[], t: number, price: Wad, max = CANDLE_CACHE_SIZE): boolean {
  const last = series[series.length - 1];
  if (last && last.t === t) {
    last.h = wmax(last.h, price);
    last.l = wmin(last.l, price);
    last.c = price;
    return true;
  }
  if (last && t < last.t) return false;
  series.push({ t, o: price, h: price, l: price, c: price });
  if (series.length > max) series.splice(0, series.length - max);
  return true;
}
const utcTimestamp = (t: number): string => new Date(t).toISOString().slice(0, -1);
function oldCandleUpsertSql(rows: Array<{ marketId: string; tf: Timeframe; t: number; price: string }>): Prisma.Sql {
  const values = rows.map(
    (r) =>
      Prisma.sql`(${r.marketId}, ${r.tf}, CAST(${utcTimestamp(r.t)} AS TIMESTAMP(3)), CAST(${r.price} AS DECIMAL(38,12)), CAST(${r.price} AS DECIMAL(38,12)), CAST(${r.price} AS DECIMAL(38,12)), CAST(${r.price} AS DECIMAL(38,12)))`,
  );
  return Prisma.sql`
    INSERT INTO "Candle" ("marketId", "tf", "t", "o", "h", "l", "c")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("marketId", "tf", "t") DO UPDATE SET
      "h" = GREATEST("Candle"."h", EXCLUDED."h"),
      "l" = LEAST("Candle"."l", EXCLUDED."l"),
      "c" = EXCLUDED."c"`;
}
/** Old runCandles for one market: memory first, then one upsert (no retries, no late-tick handling). */
async function oldRunCandles(prisma: PrismaClient, series: Map<string, OldCandle[]>, marketId: string, at: number, price: string) {
  const rows: Array<{ marketId: string; tf: Timeframe; t: number; price: string }> = [];
  const w = parseWad(price)!;
  for (const tf of TIMEFRAMES) {
    const t = Math.floor(at / TIMEFRAME_MS[tf]) * TIMEFRAME_MS[tf];
    let s = series.get(tf);
    if (!s) series.set(tf, (s = []));
    if (oldApplyTick(s, t, w)) rows.push({ marketId, tf, t, price });
  }
  if (rows.length) await prisma.$executeRaw(oldCandleUpsertSql(rows));
}
/** Old loadSeries (start-up): the last candles of every timeframe from Postgres, any source. */
async function oldLoadSeries(prisma: PrismaClient, marketId: string): Promise<Map<string, OldCandle[]>> {
  const out = new Map<string, OldCandle[]>();
  for (const tf of TIMEFRAMES) {
    const rows = await prisma.candle.findMany({ where: { marketId, tf }, orderBy: { t: 'desc' }, take: CANDLE_CACHE_SIZE });
    out.set(tf, rows.reverse().map((r) => ({ t: r.t.getTime(), o: parseWad(r.o.toFixed())!, h: parseWad(r.h.toFixed())!, l: parseWad(r.l.toFixed())!, c: parseWad(r.c.toFixed())! })));
  }
  return out;
}

const DAY = 86_400_000;
// A Wednesday, fully inside the 24/5 week; ticks every 2 s as price-relay stores them.
const T0 = Date.UTC(2026, 10, 11, 0, 0, 0);
const SYMBOLS = ['ZZRB1', 'ZZRB2', 'ZZRB3', 'ZZRB4', 'ZZRB5', 'ZZRB6', 'ZZRB7'];

describe.skipIf(!DB)('candles of unknown source rebuilt from their ticks (Postgres)', () => {
  let prisma: PrismaClient;
  const ids = new Map<string, string>();
  const cleanup = async () => {
    const ms = await prisma.market.findMany({ where: { symbol: { in: SYMBOLS } }, select: { id: true } });
    const mids = ms.map((m) => m.id);
    await prisma.candle.deleteMany({ where: { marketId: { in: mids } } });
    await prisma.priceTick.deleteMany({ where: { marketId: { in: mids } } });
    await prisma.market.deleteMany({ where: { symbol: { in: SYMBOLS } } });
  };
  const candles = async (sym: string, tf: Timeframe) =>
    (await prisma.candle.findMany({ where: { marketId: ids.get(sym)!, tf }, orderBy: { t: 'asc' } })).map((c) => ({ t: c.t.getTime(), o: c.o.toFixed(), h: c.h.toFixed(), l: c.l.toFixed(), c: c.c.toFixed(), source: c.source }));
  const retag = async (sym: string) => prisma.$executeRaw(retagUnknownCandlesSql(ids.get(sym)!, null));

  /** Robinhood-like quotes: a new 4-decimal midpoint every ~15 s, repeated in between (2-s polls). */
  const quotes = (n: number, seed: number) => {
    let x = seed;
    let p = 391.65;
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      if (i % 7 === 0) {
        x = (x * 1103515245 + 12345) % 2 ** 31;
        p = Math.max(1, p * (1 + ((x / 2 ** 31) - 0.5) * 0.004));
      }
      out.push(p.toFixed(4).replace(/\.?0+$/, ''));
    }
    return out;
  };

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@velum/db');
    prisma = new Client({ datasources: { db: { url: DB! } } });
    await cleanup();
    for (const s of SYMBOLS) ids.set(s, (await prisma.market.create({ data: { symbol: s, name: s, status: 'live', maxLeverage: 5, takerFeeBps: 6 } })).id);
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  /** Three hours of robinhood ticks (2-s polls) built with the 96c4864 builder; `lost(i)`: that tick's candle job never ran. */
  async function oldHistory(sym: string, prices: string[], lost: (i: number) => boolean, restartAt?: number) {
    const id = ids.get(sym)!;
    let series = new Map<string, OldCandle[]>();
    const ticks: Array<{ marketId: string; price: string; source: string; at: Date }> = [];
    for (let i = 0; i < prices.length; i++) {
      const at = T0 + i * 2000;
      ticks.push({ marketId: id, price: prices[i]!, source: 'robinhood', at: new Date(at) });
      if (i === restartAt) series = await oldLoadSeries(prisma, id); // the new process loads its series
      if (!lost(i)) await oldRunCandles(prisma, series, id, at, prices[i]!);
    }
    await prisma.priceTick.createMany({ data: ticks });
  }

  it('the 96c4864 builder alone is not the cause: with every candle job applied its candles pass the current proof', async () => {
    await oldHistory('ZZRB4', quotes(3 * 1800, 11), () => false);
    expect((await candles('ZZRB4', '1h')).every((c) => c.source === null)).toBe(true);
    await retag('ZZRB4');
    for (const tf of TIMEFRAMES) expect((await candles('ZZRB4', tf)).every((c) => c.source === 'robinhood')).toBe(true);
  }, 120_000);

  it('reproduces: candle jobs the old builder lost (no retries, a restart drops the queue) leave buckets the re-tag cannot prove', async () => {
    // A restart (pm2 reload on deploy) at tick 4000 drops 24 s of queued candle jobs: before late-tick handling and
    // retries existed those ticks were stored but never folded. Here they carry the hour's high (a short spike).
    const prices = quotes(3 * 1800, 7);
    for (let i = 4000; i < 4012; i++) prices[i] = (Number(prices[i]) * 1.05).toFixed(4);
    await oldHistory('ZZRB1', prices, (i) => i >= 4000 && i < 4012, 4012);
    await retag('ZZRB1');
    const spike = T0 + 4000 * 2000;
    for (const tf of TIMEFRAMES) {
      const ms = TIMEFRAME_MS[tf];
      for (const c of await candles('ZZRB1', tf)) {
        const holdsSpike = spike >= c.t && spike < c.t + ms;
        expect(c.source).toBe(holdsSpike ? null : 'robinhood');
      }
    }
  }, 120_000);

  it('reproduces: candles deleted by a source-change reset are gone while their real ticks stay', async () => {
    // Migration 20261115000000 gave the column DEFAULT 'demo': an older release still running during a deploy (or
    // switched back to by deploy.sh) stored real candles as 'demo', and the next start took them as a switch from
    // simulated to real prices: resetHistoryOnSourceChange ran DELETE FROM "Candle" and kept the robinhood ticks.
    await oldHistory('ZZRB3', quotes(1800, 5), () => false);
    await prisma.candle.deleteMany({ where: { marketId: ids.get('ZZRB3')! } }); // what the reset did
    expect(await prisma.priceTick.count({ where: { marketId: ids.get('ZZRB3')! } })).toBe(1800);
    await retag('ZZRB3');
    expect(await candles('ZZRB3', '1h')).toEqual([]); // nothing left to tag: the 1h chart shows only new candles
  }, 120_000);

  it('rebuilds them from the ticks: exact OHLC (first tick opens, last closes), tagged with the ticks source', async () => {
    const id = ids.get('ZZRB1')!;
    const now = T0 + 3 * 3_600_000 + 10 * 60_000;
    const n = await rebuildCandlesFromTicks(prisma, silent, { now, marketIds: [id] });
    expect(n).toBeGreaterThan(0);
    const ticks = await prisma.priceTick.findMany({ where: { marketId: id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    for (const tf of ['15m', '1h'] as const) {
      const ms = TIMEFRAME_MS[tf];
      const got = await candles('ZZRB1', tf);
      const closed = got.filter((c) => c.t + ms <= now - 120_000);
      expect(closed.length).toBe(tf === '1h' ? 3 : 12);
      for (const c of closed) {
        const inside = ticks.filter((k) => k.at.getTime() >= c.t && k.at.getTime() < c.t + ms).map((k) => parseWad(k.price.toFixed())!);
        expect(c.source).toBe('robinhood');
        expect(parseWad(c.o)).toBe(inside[0]);
        expect(parseWad(c.c)).toBe(inside[inside.length - 1]);
        expect(parseWad(c.h)).toBe(inside.reduce((a, b) => (b > a ? b : a)));
        expect(parseWad(c.l)).toBe(inside.reduce((a, b) => (b < a ? b : a)));
      }
    }
    // The 4-hour and daily buckets are still open at `now`: left to the live builder (still unknown here).
    expect((await candles('ZZRB1', '4h')).every((c) => c.source === null)).toBe(true);
    expect((await candles('ZZRB1', '1D')).every((c) => c.source === null)).toBe(true);
  }, 60_000);

  it('recreates candles a reset deleted, from the ticks that stayed', async () => {
    const id = ids.get('ZZRB3')!;
    await rebuildCandlesFromTicks(prisma, silent, { now: T0 + DAY + 3_600_000, marketIds: [id] });
    const hourly = await candles('ZZRB3', '1h');
    expect(hourly.map((c) => c.t)).toEqual([T0]);
    expect(hourly[0]!.source).toBe('robinhood');
    const ticks = (await prisma.priceTick.findMany({ where: { marketId: id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })).map((k) => k.price.toFixed());
    expect(hourly[0]).toMatchObject({ o: ticks[0], c: ticks[ticks.length - 1] });
    expect((await candles('ZZRB3', '1D')).map((c) => c.source)).toEqual(['robinhood']); // the day is over at `now`
  }, 60_000);

  it('is idempotent: a second run writes nothing and changes nothing', async () => {
    const id = ids.get('ZZRB1')!;
    const now = T0 + 3 * 3_600_000 + 10 * 60_000;
    const snap = JSON.stringify(await candles('ZZRB1', '15m'));
    expect(await rebuildCandlesFromTicks(prisma, silent, { now, marketIds: [id] })).toBe(0);
    expect(JSON.stringify(await candles('ZZRB1', '15m'))).toBe(snap);
    // A caller's set of finished days skips them entirely next time.
    const done = new Set<string>();
    await rebuildCandlesFromTicks(prisma, silent, { now: T0 + DAY * 2, marketIds: [id], done });
    expect([...done]).toEqual([`${id}:${T0}`]);
  }, 60_000);

  it('leaves buckets with a demo tick, mixed kinds, no ticks, or pruned ticks exactly as they are (F-4)', async () => {
    const id = ids.get('ZZRB5')!;
    const H = 3_600_000;
    const t1 = T0 + H; // demo-seeded candle with a later robinhood tick in it (mixed)
    const t2 = T0 + 2 * H; // demo ticks only
    const t3 = T0 + 3 * H; // no ticks at all (a seeded candle)
    const t4 = T0 + 4 * H; // robinhood only: rebuilt
    const seeded = (t: number) => ({ marketId: id, tf: '1h', t: new Date(t), o: '100', h: '120', l: '90', c: '110', source: null });
    await prisma.candle.createMany({ data: [seeded(t1), seeded(t2), seeded(t3), seeded(t4)] });
    await prisma.priceTick.createMany({
      data: [
        { marketId: id, price: '99', source: 'robinhood', at: new Date(T0) },
        { marketId: id, price: '100', source: 'demo', at: new Date(t1 + 1000) },
        { marketId: id, price: '101', source: 'robinhood', at: new Date(t1 + 3000) },
        { marketId: id, price: '102', source: 'demo', at: new Date(t2 + 1000) },
        { marketId: id, price: '103.5', source: 'robinhood', at: new Date(t4 + 1000) },
        { marketId: id, price: '103.25', source: 'robinhood', at: new Date(t4 + 3000) },
      ],
    });
    // A bucket that starts before the oldest stored tick lost ticks to the prune: ZZRB6 has a candle at T0 and ticks from T0 + 30 min.
    const id6 = ids.get('ZZRB6')!;
    await prisma.candle.create({ data: { marketId: id6, tf: '1h', t: new Date(T0), o: '50', h: '60', l: '40', c: '55', source: null } });
    await prisma.priceTick.createMany({ data: [{ marketId: id6, price: '51', source: 'robinhood', at: new Date(T0 + 1_800_000) }] });

    await rebuildCandlesFromTicks(prisma, silent, { now: T0 + DAY * 2, marketIds: [id, id6] });
    const got = await candles('ZZRB5', '1h');
    expect(got.find((c) => c.t === t1)).toMatchObject({ o: '100', h: '120', l: '90', c: '110', source: null });
    expect(got.find((c) => c.t === t2)).toMatchObject({ o: '100', source: null });
    expect(got.find((c) => c.t === t3)).toMatchObject({ o: '100', source: null });
    expect(got.find((c) => c.t === t4)).toMatchObject({ o: '103.5', h: '103.5', l: '103.25', c: '103.25', source: 'robinhood' });
    // The day holds a demo tick: its 1D bucket is mixed and never becomes real.
    expect((await candles('ZZRB5', '1D')).every((c) => c.source !== 'robinhood')).toBe(true);
    expect((await candles('ZZRB6', '1h')).find((c) => c.t === T0)).toMatchObject({ o: '50', source: null });
  });

  it('never touches a tagged candle (the live builder owns those)', async () => {
    const id = ids.get('ZZRB7')!;
    await prisma.candle.create({ data: { marketId: id, tf: '1h', t: new Date(T0), o: '10', h: '12', l: '9', c: '11', source: 'robinhood' } });
    await prisma.priceTick.createMany({ data: [{ marketId: id, price: '10', source: 'robinhood', at: new Date(T0 + 1000) }] });
    await rebuildCandlesFromTicks(prisma, silent, { now: T0 + DAY * 2, marketIds: [id] });
    expect((await candles('ZZRB7', '1h')).find((c) => c.t === T0)).toMatchObject({ o: '10', h: '12', l: '9', c: '11', source: 'robinhood' });
  });
});
