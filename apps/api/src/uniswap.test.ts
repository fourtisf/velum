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
