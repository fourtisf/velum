/**
 * Real perps metrics from Lighter (packages/config/src/perps-ref.ts, jobs/perp-ref.ts), checked against trimmed real
 * API responses read on 2026-11-16 (__fixtures__/lighter-2026-11-16.json).
 */
import { cacheKeys } from '@velum/config';
import { LIGHTER_API, LIGHTER_MARKETS, PERP_REF_MAX_AGE_MS, lighterHourlyFundingPct, lighterRef, mulDecimal, parsePerpRef } from '@velum/config/src/perps-ref';
import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/lighter-2026-11-16.json';
import { mainnetTestMac } from './__fixtures__/mac';
import { runPerpRef } from './jobs/perp-ref';
import type { Logger } from './lib/log';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const AT = Date.UTC(2026, 10, 16, 5, 15);
const detail = fixture.orderBookDetails.order_book_details[0]!;
const rates = fixture.fundingRates.funding_rates;

describe('lighterRef on the real responses', () => {
  it('TSLA: mark, index, funding per hour and one-sided open interest', () => {
    const r = lighterRef('TSLA', detail, rates, AT)!;
    expect(r).toEqual({ symbol: 'TSLA', venue: 'lighter', market: 112, mark: '385.49', index: '385.51', fundingPerHour: '0.000400', openInterest: '3127763.28', at: AT });
    // Lighter's own open_interest_usd counts both sides: exactly twice ours (to the cent).
    expect(Math.abs(Number(detail.open_interest_usd) / 2 - Number(r.openInterest))).toBeLessThan(0.01);
  });
  it('funding: Lighter reports a fraction per 8 hours; per hour in percent is rate x 100 / 8, sign kept (shorts pay below 0)', () => {
    expect(lighterHourlyFundingPct(3.2e-5)).toBe('0.000400');
    expect(lighterHourlyFundingPct(-0.000352)).toBe('-0.004400');
    expect(lighterHourlyFundingPct(0)).toBe('0.000000');
    expect(lighterHourlyFundingPct(-0)).toBe('0.000000');
    expect(lighterHourlyFundingPct(0.5)).toBeNull(); // 6.25%/h: beyond Lighter's 4% clamp
    expect(lighterHourlyFundingPct('0.0001')).toBeNull();
    expect(lighterHourlyFundingPct(Number.NaN)).toBeNull();
  });
  it('refuses another symbol or market, a market that is not an active unfrozen perp, bad numbers, no funding entry', () => {
    expect(lighterRef('AAPL', detail, rates, AT)).toBeNull();
    expect(lighterRef('NFLX', detail, rates, AT)).toBeNull();
    expect(lighterRef('TSLA', { ...detail, market_id: 113 }, rates, AT)).toBeNull();
    expect(lighterRef('TSLA', { ...detail, status: 'inactive' }, rates, AT)).toBeNull();
    expect(lighterRef('TSLA', { ...detail, is_frozen: true }, rates, AT)).toBeNull();
    expect(lighterRef('TSLA', { ...detail, market_type: 'spot' }, rates, AT)).toBeNull();
    expect(lighterRef('TSLA', { ...detail, mark_price: '0' }, rates, AT)).toBeNull();
    expect(lighterRef('TSLA', { ...detail, mark_price: '1e3' }, rates, AT)).toBeNull();
    expect(lighterRef('TSLA', { ...detail, open_interest: -1 }, rates, AT)).toBeNull();
    expect(lighterRef('TSLA', detail, rates.filter((x) => x.exchange !== 'lighter'), AT)).toBeNull();
    expect(lighterRef('TSLA', detail, null, AT)).toBeNull();
  });
  it('multiplies decimals exactly, rounding down', () => {
    expect(mulDecimal('8113.7339', '385.49', 2)).toBe('3127763.28');
    expect(mulDecimal('0', '385.49', 2)).toBe('0.00');
    expect(mulDecimal('1.005', '1', 2)).toBe('1.00');
  });
});

describe('PerpRef in Redis', () => {
  it('round-trips and refuses tampered, foreign or future values', () => {
    const r = lighterRef('TSLA', detail, rates, AT)!;
    expect(parsePerpRef(JSON.stringify(r), 'TSLA', AT)).toEqual(r);
    expect(parsePerpRef(JSON.stringify(r), 'AAPL', AT)).toBeNull();
    expect(parsePerpRef(JSON.stringify({ ...r, market: 1 }), 'TSLA', AT)).toBeNull();
    expect(parsePerpRef(JSON.stringify({ ...r, fundingPerHour: '1e9' }), 'TSLA', AT)).toBeNull();
    expect(parsePerpRef(JSON.stringify({ ...r, at: AT + 60_000 }), 'TSLA', AT)).toBeNull();
    expect(parsePerpRef('{', 'TSLA', AT)).toBeNull();
    expect(PERP_REF_MAX_AGE_MS).toBe(300_000);
  });
});

describe('runPerpRef', () => {
  it('reads funding once and each market once, and stores only validated references, authenticated, with a TTL', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.endsWith('/funding-rates')) return new Response(JSON.stringify(fixture.fundingRates));
      if (url.endsWith(`market_id=${LIGHTER_MARKETS.TSLA}`)) return new Response(JSON.stringify(fixture.orderBookDetails));
      if (url.endsWith(`market_id=${LIGHTER_MARKETS.AAPL}`)) return new Response(JSON.stringify({ code: 200, order_book_details: [{ ...detail, symbol: 'AAPL' }] }));
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    const sets: Array<[string, string, string, number]> = [];
    const redis = {
      pipeline: () => ({
        set(k: string, v: string, ex: string, ttl: number) {
          sets.push([k, v, ex, ttl]);
          return this;
        },
        exec: async () => [],
      }),
    };
    const done = await runPerpRef({ redis: redis as never, mac: mainnetTestMac, log: silent, fetchImpl, now: () => AT, symbols: ['TSLA', 'AAPL', 'MSFT'] });
    expect(done).toEqual(['TSLA']);
    expect(urls[0]).toBe(`${LIGHTER_API}/api/v1/funding-rates`);
    expect(urls).toHaveLength(4);
    expect(sets).toHaveLength(1);
    const [key, sealed, ex, ttl] = sets[0]!;
    expect(key).toBe(cacheKeys.perpRef('TSLA'));
    expect([ex, ttl]).toEqual(['EX', 900]);
    expect(parsePerpRef(mainnetTestMac.open(key, sealed, 2048), 'TSLA', AT)?.fundingPerHour).toBe('0.000400');
  });
  it('stores nothing when the funding read fails', async () => {
    const fetchImpl = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    const redis = { pipeline: () => ({ set() { throw new Error('no write expected'); }, exec: async () => [] }) };
    expect(await runPerpRef({ redis: redis as never, mac: mainnetTestMac, log: silent, fetchImpl })).toEqual([]);
  });
});
