import { CANDLE_CACHE_SIZE, MARKETS, SPARK_INTERVAL_MS, SPARK_POINTS, TIMEFRAME_MS, TIMEFRAMES } from '@velum/config';
import { parseWad } from '@velum/math';
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';
import { applyTick, bucketStart, candleUpsertSql, toCandle, type WadCandle } from './lib/candles';
import { MIN_PRICE, floatToDec, gauss, genCandles, genSpark, seedOpen24h, stepPrice } from './lib/demo';
import { buildSnapshot, markOf } from './lib/snapshot';
import { RH_JUMP_CONFIRMATIONS, RH_MAX_QUOTE_AGE_MS, jumpGuard, pickSource, redactUrls, rhMid, robinhoodSource } from './sources';
import { demoSource } from './sources';

/** Deterministic PRNG (mulberry32) so tests are repeatable. */
function rng(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = Date.UTC(2026, 10, 14, 10, 37, 21, 500);
const w = (s: string) => parseWad(s)!;

describe('demo random walk', () => {
  it('gauss has roughly unit variance', () => {
    const r = rng();
    const xs = Array.from({ length: 20000 }, () => gauss(r));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const varc = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(varc - 1)).toBeLessThan(0.05);
  });

  it('never goes below the floor and stays near its anchor over a simulated week', () => {
    const r = rng(7);
    for (const m of MARKETS) {
      const seed = Number(m.seedPrice);
      let p = seed;
      let lo = p;
      let hi = p;
      for (let i = 0; i < 302_400; i++) {
        p = stepPrice(p, m.vol, seed, r);
        lo = Math.min(lo, p);
        hi = Math.max(hi, p);
      }
      expect(lo).toBeGreaterThanOrEqual(MIN_PRICE);
      expect(lo / seed, m.symbol).toBeGreaterThan(0.55);
      expect(hi / seed, m.symbol).toBeLessThan(1.8);
    }
  });

  it('floors tiny prices at 1', () => {
    expect(stepPrice(1, 0.5, 400, () => 0.999999)).toBeGreaterThanOrEqual(MIN_PRICE);
  });

  it('formats floats as clean decimals', () => {
    expect(floatToDec(391.6549999)).toBe('391.65');
    expect(floatToDec(391.655)).toBe('391.66');
    expect(floatToDec(100)).toBe('100');
    expect(floatToDec(1e-7, 4)).toBe('0');
  });

  it('demo source walks every market from the last price', async () => {
    const src = demoSource(rng(3));
    const first = await src.read(new Map([['TSLA', '500.00']]), NOW);
    expect(first.size).toBe(MARKETS.length);
    expect(Math.abs(Number(first.get('TSLA')) - 500)).toBeLessThan(10);
    for (const v of first.values()) expect(v).toMatch(/^\d+(\.\d{1,2})?$/);
  });

  it('seeds the 24h open within the prototype band', () => {
    const r = rng(9);
    for (let i = 0; i < 1000; i++) {
      const o = seedOpen24h(100, r);
      expect(o).toBeGreaterThanOrEqual(96.6);
      expect(o).toBeLessThanOrEqual(103);
    }
  });
});

describe('candle buckets', () => {
  it('aligns buckets to UTC', () => {
    expect(bucketStart(NOW, '15m')).toBe(Date.UTC(2026, 10, 14, 10, 30));
    expect(bucketStart(NOW, '1h')).toBe(Date.UTC(2026, 10, 14, 10));
    expect(bucketStart(NOW, '4h')).toBe(Date.UTC(2026, 10, 14, 8));
    expect(bucketStart(NOW, '1D')).toBe(Date.UTC(2026, 10, 14));
  });

  it('updates the current bucket, opens new ones, ignores late ticks and caps length', () => {
    const s: WadCandle[] = [];
    expect(applyTick(s, 0, w('100'))).toBe(true);
    applyTick(s, 0, w('103'));
    applyTick(s, 0, w('98'));
    applyTick(s, 0, w('101'));
    expect(toCandle(s[0]!)).toEqual({ t: 0, o: '100', h: '103', l: '98', c: '101' });
    applyTick(s, 60, w('102'));
    expect(toCandle(s[1]!)).toEqual({ t: 60, o: '102', h: '102', l: '102', c: '102' });
    expect(applyTick(s, 0, w('1'))).toBe(false);
    expect(s[0]!.l).toBe(w('98'));
    for (let i = 2; i < 10; i++) applyTick(s, i * 60, w('100'), 5);
    expect(s).toHaveLength(5);
    expect(s[4]!.t).toBe(9 * 60);
  });

  it('builds a parameterised upsert', () => {
    const sql = candleUpsertSql(
      [
        { marketId: 'm1', tf: '1h', t: Date.UTC(2026, 10, 14, 10), price: '391.65' },
        { marketId: 'm2', tf: '15m', t: Date.UTC(2026, 10, 14, 10, 30), price: '233.4' },
      ],
      { source: 'robinhood' },
    );
    expect(sql.sql).toContain('ON CONFLICT ("marketId", "tf", "t") DO UPDATE');
    expect(sql.sql).toContain('GREATEST("Candle"."h", EXCLUDED."h")');
    expect(sql.sql).toContain('"source")');
    expect(sql.sql).not.toContain('391.65');
    expect(sql.values).toEqual([
      ...['m1', '1h', '2026-11-14T10:00:00.000', '391.65', '391.65', '391.65', '391.65', 'robinhood'],
      ...['m2', '15m', '2026-11-14T10:30:00.000', '233.4', '233.4', '233.4', '233.4', 'robinhood'],
    ]);
  });
});

describe('demo backfill history', () => {
  it.each(TIMEFRAMES)('is continuous and ends at the current price (%s)', (tf) => {
    const list = genCandles(391.65, 0.0017, tf, CANDLE_CACHE_SIZE, NOW, rng(11));
    expect(list).toHaveLength(CANDLE_CACHE_SIZE);
    expect(list.at(-1)!.t).toBe(bucketStart(NOW, tf));
    expect(list.at(-1)!.c).toBe(391.65);
    for (let i = 0; i < list.length; i++) {
      const c = list[i]!;
      expect(c.h).toBeGreaterThanOrEqual(Math.max(c.o, c.c));
      expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c));
      expect(c.l).toBeGreaterThan(0);
      if (i > 0) {
        expect(c.t - list[i - 1]!.t).toBe(TIMEFRAME_MS[tf]);
        expect(list[i - 1]!.c).toBe(c.o);
      }
    }
    const closes = list.map((c) => c.c);
    expect(Math.min(...closes) / 391.65).toBeGreaterThan(0.3);
    expect(Math.max(...closes) / 391.65).toBeLessThan(3);
  });

  it('generates a sparkline ending at the price', () => {
    const s = genSpark(100, 0.0017, SPARK_POINTS, 30, rng(5));
    expect(s).toHaveLength(SPARK_POINTS);
    expect(s.at(-1)).toBe(100);
  });
});

describe('snapshots', () => {
  it('computes the mark premium', () => {
    expect(markOf('391.65')).toBe('391.80');
    expect(markOf('100')).toBe('100.04');
  });

  it('keeps one spark point per minute, the last tracking the live price', () => {
    const a = buildSnapshot(undefined, 'TSLA', '100', '99', 'demo', NOW);
    expect(a).toEqual({ symbol: 'TSLA', price: '100', mark: '100.04', open24h: '99', spark: ['100'], source: 'demo', updatedAt: NOW, checkedAt: NOW });
    const b = buildSnapshot(a, 'TSLA', '101', '99', 'demo', NOW + 2000);
    expect(b.spark).toEqual(['101']);
    const c = buildSnapshot(b, 'TSLA', '102', '99', 'demo', NOW + SPARK_INTERVAL_MS);
    expect(c.spark).toEqual(['101', '102']);
    let s = c;
    for (let i = 2; i < 100; i++) s = buildSnapshot(s, 'TSLA', String(100 + i), '99', 'demo', NOW + i * SPARK_INTERVAL_MS);
    expect(s.spark).toHaveLength(SPARK_POINTS);
    expect(s.spark.at(-1)).toBe('199');
    expect(a.spark).toEqual(['100']);
  });

  it('fills downtime with the last price so the spark never splices stale history', () => {
    const a = buildSnapshot(undefined, 'TSLA', '100', '99', 'demo', NOW);
    const b = buildSnapshot(a, 'TSLA', '105', '99', 'demo', NOW + 4 * SPARK_INTERVAL_MS);
    expect(b.spark).toEqual(['100', '100', '100', '100', '105']);
    const c = buildSnapshot(b, 'TSLA', '110', '99', 'demo', NOW + 300 * SPARK_INTERVAL_MS);
    expect(c.spark).toHaveLength(SPARK_POINTS);
    expect(c.spark.slice(0, -1).every((p) => p === '105')).toBe(true);
    expect(c.spark.at(-1)).toBe('110');
  });
});

describe('env', () => {
  const base = { DATABASE_URL: 'postgresql://a', REDIS_URL: 'redis://b' };
  it('defaults and validates', () => {
    expect(loadEnv(base)).toMatchObject({ demoMode: true, pricePollMs: 2000, priceSource: 'demo', chainId: 46630, tickRetentionDays: 7 });
    expect(loadEnv({ ...base, PRICE_SOURCE: 'chainlink' }).priceSource).toBe('chainlink');
    expect(() => loadEnv({ ...base, PRICE_SOURCE: 'binance', PRICE_POLL_MS: '10', CHAIN_ID: '4663' })).toThrow(/CHAIN_ID 4663[\s\S]*PRICE_SOURCE[\s\S]*PRICE_POLL_MS/);
  });
});

describe('robinhood quotes', () => {
  const NOW = Date.parse('2026-11-14T14:37:00Z');
  const tsla = {
    tokenSymbol: 'TSLA',
    deployments: [{ contractAddress: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', chainId: 4663 }],
    tokenBid: '387.000000000000000000',
    tokenAsk: '394.830000000000000000',
    isTradingHalt: false,
    generatedAt: '2026-11-14T14:36:57.620287657Z',
  };
  it('uses the bid/ask midpoint, floored to 4 decimals', () => {
    expect(rhMid('TSLA', tsla, NOW)).toBe('390.915');
    expect(rhMid('NVDA', { ...tsla, tokenSymbol: 'NVDA', deployments: [{ contractAddress: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', chainId: 4663 }], tokenBid: '149.115498715529958655', tokenAsk: '161.174839383463757325' }, NOW)).toBe('155.1451');
  });
  it('rejects quotes for another contract, halted, stale, crossed or missing', () => {
    expect(rhMid('TSLA', { ...tsla, deployments: [{ contractAddress: '0x0000000000000000000000000000000000000001', chainId: 4663 }] }, NOW)).toBeNull();
    expect(rhMid('TSLA', { ...tsla, deployments: [{ contractAddress: tsla.deployments[0]!.contractAddress, chainId: 1 }] }, NOW)).toBeNull();
    expect(rhMid('TSLA', { ...tsla, isTradingHalt: true }, NOW)).toBeNull();
    expect(rhMid('TSLA', tsla, NOW + RH_MAX_QUOTE_AGE_MS + 5000)).toBeNull();
    expect(rhMid('TSLA', { ...tsla, tokenBid: '400', tokenAsk: '390' }, NOW)).toBeNull();
    expect(rhMid('TSLA', { ...tsla, tokenBid: '0' }, NOW)).toBeNull();
    expect(rhMid('TSLA', undefined, NOW)).toBeNull();
    expect(rhMid('AMZN', tsla, NOW)).toBeNull();
  });
  it('reads every market through fetch and skips failures', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      if (url.endsWith('/TSLA')) return new Response(JSON.stringify({ quotes: [{ ...tsla, generatedAt: new Date().toISOString() }] }), { status: 200 });
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;
    const silent = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Parameters<typeof robinhoodSource>[0];
    const out = await robinhoodSource(silent, fake).read(new Map(), Date.now());
    expect(calls).toHaveLength(10);
    expect([...out.entries()]).toEqual([['TSLA', '390.915']]);
  });
});

describe('robinhood quote hardening (audit M1, L1, L7)', () => {
  const NOW = Date.parse('2026-11-14T14:37:00Z');
  const base = {
    tokenSymbol: 'TSLA',
    deployments: [{ contractAddress: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', chainId: 4663 }],
    tokenBid: '387',
    tokenAsk: '394.83',
    isTradingHalt: false,
    generatedAt: '2026-11-14T14:36:57Z',
  };
  it('rejects absurd spreads, overflow, loose number formats and future or old stamps', () => {
    expect(rhMid('TSLA', base, NOW)).toBe('390.915');
    expect(rhMid('TSLA', { ...base, tokenBid: '0.01', tokenAsk: '10000' }, NOW)).toBeNull();
    expect(rhMid('TSLA', { ...base, tokenBid: '1e30', tokenAsk: '1e30' }, NOW)).toBeNull();
    expect(rhMid('TSLA', { ...base, tokenBid: '999999999999', tokenAsk: '999999999999' }, NOW)).toBeNull();
    expect(rhMid('TSLA', { ...base, tokenBid: '1,234.50', tokenAsk: '1,240.00' }, NOW)).toBeNull();
    expect(rhMid('TSLA', { ...base, generatedAt: '2026-11-15T14:37:00Z' }, NOW)).toBeNull();
    expect(rhMid('TSLA', base, NOW + RH_MAX_QUOTE_AGE_MS + 1000)).toBeNull();
  });
  it('holds a large jump until consecutive quotes confirm it', () => {
    const accept = jumpGuard();
    expect(accept('TSLA', '391', undefined)).toBe(true);
    expect(accept('TSLA', '395', '391')).toBe(true);
    for (let i = 1; i < RH_JUMP_CONFIRMATIONS; i++) expect(accept('TSLA', '5000', '391')).toBe(false);
    expect(accept('TSLA', '5000', '391')).toBe(true);
    expect(accept('TSLA', '9000', '391')).toBe(false);
    expect(accept('TSLA', '392', '391')).toBe(true);
  });
  it('removes URLs from logged errors', () => {
    expect(redactUrls('HTTP request failed. URL: https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY123 Details')).toBe('HTTP request failed. URL: https://robinhood-mainnet.g.alchemy.com/… Details');
  });
  it('refuses PRICE_SOURCE=chainlink without verified feeds instead of faking real prices', () => {
    const silent = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Parameters<typeof pickSource>[2];
    expect(() => pickSource('chainlink', 'https://rpc.example', silent)).toThrow(/no verified price feeds/);
  });
});
