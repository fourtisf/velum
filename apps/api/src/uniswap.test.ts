/**
 * PRICE_SOURCE=uniswap in the API: a Uniswap price trades 24/7 onchain, so it is live on weekends and US holidays
 * (no marketClosed, no quoteFrozen) while the workers keep reading the pools, and its market reports open.
 */
import type { MarketSnapshot } from '@velum/config';
import { describe, expect, it } from 'vitest';
import { MAX_PRICE_AGE_MS, priceState } from './lib/market-view';

// Sunday 2026-11-15 18:00 UTC: the US-equity session is closed.
const SUNDAY = Date.UTC(2026, 10, 15, 18, 0, 0);
const snap = (source: MarketSnapshot['source'], over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  symbol: 'TSLA',
  price: '387.1',
  mark: '387.25',
  open24h: '385',
  spark: ['387.1'],
  source,
  updatedAt: SUNDAY - 3_600_000,
  checkedAt: SUNDAY - 1000,
  ...over,
});

describe('Uniswap prices are live 24/7', () => {
  it('is live and open on a Sunday, even after an hour without a pool change', () => {
    expect(priceState(snap('uniswap'), SUNDAY, 'mainnet')).toEqual({ stale: false, staleReason: null, marketOpen: true, quoteAge: 3600 });
  });
  it('still goes stale when the workers stop reading the pools', () => {
    expect(priceState(snap('uniswap', { checkedAt: SUNDAY - MAX_PRICE_AGE_MS - 1 }), SUNDAY, 'mainnet').staleReason).toBe('outdated');
  });
  it('leaves the Robinhood quote closed on the same Sunday', () => {
    expect(priceState(snap('robinhood'), SUNDAY, 'mainnet')).toMatchObject({ stale: true, staleReason: 'marketClosed', marketOpen: false });
  });
});

describe('perps reference from Lighter (mainnet)', () => {
  const ref = { symbol: 'TSLA', venue: 'lighter' as const, market: 112, mark: '385.64', index: '385.64', fundingPerHour: '0.000400', openInterest: '3127455.94', at: SUNDAY - 30_000 };
  const seed = { symbol: 'TSLA', name: 'Tesla', seedPrice: '391.65', vol: 0, openInterest: '1', fundingPerHour: '0.0042', status: 'live' as const, token: null };
  it('serves mark, funding and open interest from a fresh Lighter read, with the venue', async () => {
    const { marketView } = await import('./lib/market-view');
    const v = marketView(seed, snap('uniswap'), SUNDAY, 'mainnet', true, ref);
    expect([v.mark, v.fundingPerHour, v.openInterest, v.demo]).toEqual(['385.64', '0.000400', '3127455.94', false]);
    expect(v.perpsRef).toEqual({ venue: 'lighter', market: 112, index: '385.64', at: ref.at });
  });
  it('drops a stale read, a read for another market, and never uses one on testnet', async () => {
    const { marketView } = await import('./lib/market-view');
    const old = marketView(seed, snap('uniswap'), SUNDAY, 'mainnet', true, { ...ref, at: SUNDAY - 301_000 });
    expect([old.fundingPerHour, old.openInterest, old.perpsRef]).toEqual([null, null, null]);
    expect(marketView(seed, snap('uniswap'), SUNDAY, 'mainnet', true, { ...ref, symbol: 'AAPL' }).perpsRef).toBeNull();
    const t = marketView(seed, snap('demo'), SUNDAY, 'testnet', true, ref);
    expect([t.fundingPerHour, t.perpsRef]).toEqual(['0.0042', null]);
  });
});
