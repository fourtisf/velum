/**
 * Real perps metrics from Hyperliquid's xyz dex and from Lighter (packages/config/src/perps-ref.ts, jobs/perp-ref.ts),
 * checked against trimmed real API responses read on 2026-11-16 (__fixtures__/hyperliquid-xyz-2026-11-16.json,
 * __fixtures__/lighter-2026-11-16.json).
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
    const done = await runPerpRef({ redis: redis as never, mac: mainnetTestMac, log: silent, fetchImpl, now: () => AT, symbols: ['TSLA', 'AAPL', 'MSFT'], venue: 'lighter' });
    expect(done).toEqual(['TSLA']);
    expect(urls[0]).toBe(`${LIGHTER_API}/api/v1/funding-rates`);
    expect(urls).toHaveLength(4);
    expect(sets).toHaveLength(1);
    const [key, sealed, ex, ttl] = sets[0]!;
    expect(key).toBe(cacheKeys.perpRef('TSLA'));
    expect([ex, ttl]).toEqual(['EX', 900]);
    expect(parsePerpRef(mainnetTestMac.open(key, sealed, 2048), 'TSLA', AT)?.fundingPerHour).toBe('0.000400');
  });
  it('stores nothing when the venue read fails', async () => {
    const fetchImpl = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    const redis = { pipeline: () => ({ set() { throw new Error('no write expected'); }, exec: async () => [] }) };
    expect(await runPerpRef({ redis: redis as never, mac: mainnetTestMac, log: silent, fetchImpl, venue: 'lighter' })).toEqual([]);
    expect(await runPerpRef({ redis: redis as never, mac: mainnetTestMac, log: silent, fetchImpl })).toEqual([]);
  });
});

/** The fixture's metaAndAssetCtxs answer: [meta, asset contexts]. */
type HlBody = [{ universe: Array<Record<string, unknown>> }, Array<Record<string, string>>];
const hlBody = async (): Promise<HlBody> => (await import('./__fixtures__/hyperliquid-xyz-2026-11-16.json')).default.body as unknown as HlBody;

describe('Hyperliquid xyz reference (real response, 2026-11-16)', () => {
  it('reads every Velum market at its pinned index: mark, oracle as index, hourly funding, one-sided OI in USD', async () => {
    const hl = { body: await hlBody() };
    const { HL_MARKETS, hlAssetId, hlHourlyFundingPct } = await import('@velum/config/src/hyperliquid');
    const { hyperliquidRef, parsePerpRef } = await import('@velum/config/src/perps-ref');
    const r = hyperliquidRef('TSLA', hl.body, AT)!;
    expect(r).toEqual({ symbol: 'TSLA', venue: 'hyperliquid', market: 110001, mark: '383.93', index: '383.93', fundingPerHour: '0.000625', openInterest: mulDecimal('106305.654', '383.93', 2), at: AT });
    for (const s of Object.keys(HL_MARKETS)) expect(hyperliquidRef(s, hl.body, AT)?.market, s).toBe(hlAssetId(HL_MARKETS[s]!.index));
    expect(parsePerpRef(JSON.stringify(r), 'TSLA', AT)).toEqual(r);
    expect(parsePerpRef(JSON.stringify({ ...r, market: 112 }), 'TSLA', AT)).toBeNull();
    // A shifted universe (another coin at the pinned index), a delisted market or a bad number gives none.
    const shifted = [{ ...hl.body[0], universe: [...hl.body[0].universe].reverse() }, hl.body[1]];
    expect(hyperliquidRef('TSLA', shifted, AT)).toBeNull();
    const delisted = [{ ...hl.body[0], universe: hl.body[0].universe.map((u, i) => (i === 1 ? { ...u, isDelisted: true } : u)) }, hl.body[1]];
    expect(hyperliquidRef('TSLA', delisted, AT)).toBeNull();
    const badMark = [hl.body[0], hl.body[1].map((c, i) => (i === 1 ? { ...c, markPx: '0' } : c))];
    expect(hyperliquidRef('TSLA', badMark, AT)).toBeNull();
    expect(hlHourlyFundingPct('0.00000625')).toBe('0.000625');
    expect(hlHourlyFundingPct('-0.0001')).toBe('-0.010000');
    expect(hlHourlyFundingPct('0.01')).toBeNull(); // 1%/h: beyond Hyperliquid's 0.5% cap
  });
  it('runPerpRef (default venue) reads one metaAndAssetCtxs and stores a reference per market', async () => {
    const hl = { body: await hlBody() };
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      return new Response(JSON.stringify(hl.body));
    }) as typeof fetch;
    const keys: string[] = [];
    const redis = { pipeline: () => ({ set(k: string) { keys.push(k); return this; }, exec: async () => [] }) };
    const done = await runPerpRef({ redis: redis as never, mac: mainnetTestMac, log: silent, fetchImpl, now: () => AT });
    expect(done.sort()).toEqual(['AAPL', 'AMD', 'AMZN', 'COIN', 'META', 'MSFT', 'NFLX', 'NVDA', 'PLTR', 'TSLA']);
    expect(calls).toEqual([{ url: 'https://api.hyperliquid.xyz/info', body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: 'xyz' }) }]);
    expect(keys).toContain(cacheKeys.perpRef('NFLX'));
  });
  it('hlCheckMarket refuses a market that moved or was delisted', async () => {
    const hl = { body: await hlBody() };
    const { hlCheckMarket } = await import('@velum/config/src/hyperliquid');
    expect(hlCheckMarket('NFLX', hl.body[0].universe)).toMatchObject({ coin: 'xyz:NFLX', asset: 110019, szDecimals: 3, crossAllowed: false });
    expect(hlCheckMarket('TSLA', [...hl.body[0].universe].reverse())).toBeNull();
    expect(hlCheckMarket('NOPE', hl.body[0].universe)).toBeNull();
  });
});
