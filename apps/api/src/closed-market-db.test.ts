/**
 * The Postgres readers behind the closed-market fields (lib/adapters.ts prismaDb): session closes from real 15-minute
 * candles only, candles by time range, and the display-only DEX candles. Needs TEST_DATABASE_URL (a migrated scratch
 * database); skipped otherwise.
 */
import type { PrismaClient } from '@velum/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaDb } from './lib/adapters';

const DB = process.env.TEST_DATABASE_URL;
const Z = (s: string) => Date.parse(s);

describe.skipIf(!DB)('closed-market readers on Postgres', () => {
  let prisma: PrismaClient;
  const SYMS = ['ZZCM1', 'ZZCM2'];
  const ids = new Map<string, string>();
  const FRI = Z('2026-11-14T00:45:00Z'); // the quarter hour that ends at Friday 20:00 EST
  const THU = Z('2026-11-13T00:45:00Z');
  const cleanup = async () => {
    const ms = await prisma.market.findMany({ where: { symbol: { in: SYMS } }, select: { id: true } });
    await prisma.candle.deleteMany({ where: { marketId: { in: ms.map((m) => m.id) } } });
    await prisma.market.deleteMany({ where: { symbol: { in: SYMS } } });
    await prisma.dexCandle.deleteMany({ where: { symbol: { in: SYMS } } });
  };
  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@velum/db');
    prisma = new Client({ datasources: { db: { url: DB! } } });
    await cleanup();
    for (const s of SYMS) ids.set(s, (await prisma.market.create({ data: { symbol: s, name: s, status: 'live', maxLeverage: 5, takerFeeBps: 6 } })).id);
    const c = (sym: string, tf: string, t: number, close: string, source: string | null) => ({ marketId: ids.get(sym)!, tf, t: new Date(t), o: close, h: close, l: close, c: close, source });
    await prisma.candle.createMany({
      data: [
        c('ZZCM1', '15m', FRI, '391.65', 'robinhood'),
        c('ZZCM1', '15m', THU, '396.56', 'robinhood'),
        c('ZZCM2', '15m', FRI, '100', 'demo'), // never a real close
        c('ZZCM2', '15m', THU, '99', null), // unknown source: never a real close
        c('ZZCM1', '1h', Z('2026-11-13T22:00:00Z'), '390', 'robinhood'),
        c('ZZCM1', '1h', Z('2026-11-13T23:00:00Z'), '391', 'robinhood'),
        c('ZZCM1', '1h', Z('2026-11-14T00:00:00Z'), '391.65', null),
      ],
    });
    await prisma.dexCandle.createMany({
      data: [
        { symbol: 'ZZCM1', tf: '1h', t: new Date(Z('2026-11-14T10:00:00Z')), o: '160.1', h: '161.3', l: '159.8', c: '161.27', trades: 12, pool: '0xpool' },
        { symbol: 'ZZCM1', tf: '15m', t: new Date(Z('2026-11-14T10:00:00Z')), o: '160.1', h: '160.1', l: '160.1', c: '160.1', trades: 1, pool: '0xpool' },
      ],
    });
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('closesAt: real 15-minute closes only, per symbol and bucket', async () => {
    const got = await prismaDb(prisma).closesAt!([FRI, THU]);
    expect(Object.fromEntries([...(got.get('ZZCM1') ?? new Map())])).toEqual({ [FRI]: '391.65', [THU]: '396.56' });
    expect(got.has('ZZCM2')).toBe(false);
  });

  it('candlesBetween: the range, oldest first, real source only on request', async () => {
    const db = prismaDb(prisma);
    const all = await db.candlesBetween!('ZZCM1', '1h', Z('2026-11-13T22:00:00Z'), Z('2026-11-14T00:00:00Z'));
    expect(all.map((k) => k.c)).toEqual(['390', '391', '391.65']);
    const real = await db.candlesBetween!('ZZCM1', '1h', Z('2026-11-13T22:00:00Z'), Z('2026-11-14T00:00:00Z'), { realOnly: true });
    expect(real.map((k) => k.c)).toEqual(['390', '391']);
  });

  it('dexCandles: the DEX table only, by timeframe', async () => {
    const got = await prismaDb(prisma).dexCandles!('ZZCM1', '1h', Z('2026-11-14T00:00:00Z'), Z('2026-11-15T00:00:00Z'));
    expect(got).toEqual([{ t: Z('2026-11-14T10:00:00Z'), o: '160.1', h: '161.3', l: '159.8', c: '161.27' }]);
  });
});
