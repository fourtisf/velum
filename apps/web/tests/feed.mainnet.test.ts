/**
 * Mainnet build, the market feed (audit web F2, F6): what counts as a live price from the API, and a
 * single polling loop with in-order answers however often the tab becomes visible again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

import { MARKETS } from '@velum/config';
import type { MarketDTO } from '@/lib/api';
import { PRICE_MAX_AGE_MS, livePrice, mk, priceOrigin, priceState, readApiMarket, startMarketFeed, tradablePrice, useMarkets } from '@/lib/markets';
import { W } from './helpers';

const NOW = 1_800_000_000_000;
const base: MarketDTO = {
  symbol: 'TSLA',
  name: 'Tesla',
  token: null,
  status: 'live',
  price: '450.00',
  mark: '450.18',
  open24h: '445.00',
  change24h: '1.12',
  fundingPerHour: '0.0042',
  openInterest: '1',
  maxLeverage: 5,
  takerFeeBps: 6,
  maintenanceMargin: '0.10',
  spark: ['449', '450'],
  stale: false,
  source: 'robinhood',
  updatedAt: NOW - 1_000,
};

describe('readApiMarket on mainnet (F2)', () => {
  const read = (patch: Partial<MarketDTO> | Record<string, unknown>) => readApiMarket({ ...base, ...patch } as MarketDTO, NOW, true);

  it('a fresh robinhood or chainlink price is live data', () => {
    expect(read({})).toEqual({ price: W('450'), noData: false, stale: false, closed: false });
    expect(read({ source: 'chainlink' }).noData).toBe(false);
  });

  it('any other source is no data: demo, null, missing, unknown', () => {
    for (const source of ['demo', null, undefined, '', 'Robinhood', 'coingecko']) expect(read({ source }).noData).toBe(true);
  });

  it('an empty or unparsable price is no data (never a fallback to an earlier or seed price)', () => {
    for (const price of ['', ' ', 'abc', 'NaN', '0', '-1', '1e999', undefined, 391.65]) expect(read({ price }).noData).toBe(true);
  });

  it('a missing stale flag means stale', () => {
    const d = { ...base } as Partial<MarketDTO>;
    delete d.stale;
    expect(readApiMarket(d as MarketDTO, NOW, true).stale).toBe(true);
    expect(read({ stale: true }).stale).toBe(true);
  });

  it('updatedAt older than the max age, missing or unreadable means stale', () => {
    expect(read({ updatedAt: NOW - PRICE_MAX_AGE_MS - 1 }).stale).toBe(true);
    expect(read({ updatedAt: NOW - PRICE_MAX_AGE_MS + 1_000 }).stale).toBe(false);
    expect(read({ updatedAt: undefined }).stale).toBe(true);
    expect(read({ updatedAt: 'yesterday' }).stale).toBe(true);
    expect(read({ updatedAt: new Date(NOW - 2_000).toISOString() }).stale).toBe(false);
  });

  it('a closed market (staleReason marketClosed, quote hours old) keeps its last price, stale and marked closed', () => {
    const r = read({ stale: true, staleReason: 'marketClosed', marketOpen: false, updatedAt: NOW - 40 * 3600e3, quoteAge: 40 * 3600e3 });
    expect(r).toEqual({ price: W('450'), noData: false, stale: true, closed: true });
    // Never live, even if a flag were missing: closed alone means stale.
    expect(read({ stale: false, staleReason: 'marketClosed', updatedAt: NOW - 1_000 })).toMatchObject({ stale: true, closed: true });
    expect(read({ stale: false, marketOpen: false }).stale).toBe(true);
    // Other stale reasons are plain stale, not closed.
    for (const staleReason of ['unavailable', 'outdated', 'quoteFrozen']) expect(read({ stale: true, staleReason })).toMatchObject({ stale: true, closed: false });
    expect(read({ stale: true, staleReason: 'demoSource', source: 'demo' }).noData).toBe(true);
  });

  it('testnet rules stay as they were: a demo source is data, only null is none', () => {
    expect(readApiMarket({ ...base, source: 'demo' }, NOW, false).noData).toBe(false);
    expect(readApiMarket({ ...base, source: null }, NOW, false).noData).toBe(true);
  });
});

describe('the live feed (F2, F6)', () => {
  let listeners: Array<() => void> = [];
  let calls = 0;
  let body: () => MarketDTO[] = () => MARKETS.map((m) => ({ ...base, symbol: m.symbol, name: m.name, price: m.symbol === 'TSLA' ? '450.00' : m.seedPrice, updatedAt: Date.now() }));
  let delayMs = 0;
  let stop: (() => void) | undefined;
  const initial = useMarkets.getState();

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    useMarkets.setState({ ...initial }, true);
    listeners = [];
    calls = 0;
    delayMs = 0;
    body = () => MARKETS.map((m) => ({ ...base, symbol: m.symbol, name: m.name, price: m.symbol === 'TSLA' ? '450.00' : m.seedPrice, updatedAt: Date.now() }));
    (globalThis as { document?: unknown }).document = {
      visibilityState: 'visible',
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => undefined,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        const payload = JSON.stringify(body());
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('an empty price from the API never shows or trades the config seed price', async () => {
    body = () => MARKETS.map((m) => ({ ...base, symbol: m.symbol, name: m.name, price: m.symbol === 'TSLA' ? '' : m.seedPrice, mark: '', updatedAt: Date.now() }));
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(mk('TSLA').noData).toBe(true);
    expect(livePrice('TSLA')).toBeNull();
    expect(priceState(mk('TSLA'), useMarkets.getState(), Date.now(), true)).toBe('none');
    expect(livePrice('AMZN')).toBe(W('233.40'));
  });

  it('a "demo" source is no data on mainnet, and the copy does not name Robinhood', async () => {
    body = () => MARKETS.map((m) => ({ ...base, symbol: m.symbol, name: m.name, price: m.seedPrice, source: 'demo', updatedAt: Date.now() }));
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    for (const m of MARKETS) expect(livePrice(m.symbol)).toBeNull();
    expect(priceOrigin(useMarkets.getState())).toBe('none');
  });

  it('robinhood prices are named as such', async () => {
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(priceOrigin(useMarkets.getState())).toBe('robinhood');
  });

  it('a closed market shows its last price marked closed and is not tradable; null funding and OI stay null (F2, backend API)', async () => {
    body = () =>
      MARKETS.map((m) => ({
        ...base,
        symbol: m.symbol,
        name: m.name,
        price: m.symbol === 'TSLA' ? '447.10' : m.seedPrice,
        fundingPerHour: null,
        openInterest: null,
        ...(m.symbol === 'TSLA' ? { stale: true, staleReason: 'marketClosed', marketOpen: false, updatedAt: Date.now() - 50 * 3600e3, quoteAge: 50 * 3600e3 } : { updatedAt: Date.now() }),
      }));
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    const tsla = mk('TSLA');
    expect(tsla.noData).toBe(false);
    expect(tsla.closed).toBe(true);
    expect(tsla.price).toBe(W('447.10'));
    expect(priceState(tsla, useMarkets.getState(), Date.now(), true)).toBe('stale');
    expect(livePrice('TSLA')).toBeNull();
    expect(tradablePrice(tsla, useMarkets.getState(), Date.now(), false)).toBe(W('447.10')); // testnet demo as before
    expect(livePrice('AMZN')).toBe(W('233.40'));
    expect(mk('AMZN').closed).toBe(false);
    expect([tsla.funding, tsla.oi]).toEqual([null, null]);
  });

  it('a price older than a minute at the server is stale, not tradable', async () => {
    body = () => MARKETS.map((m) => ({ ...base, symbol: m.symbol, name: m.name, price: m.seedPrice, updatedAt: Date.now() - PRICE_MAX_AGE_MS - 5_000 }));
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(mk('TSLA').noData).toBe(false);
    expect(livePrice('TSLA')).toBeNull();
    expect(priceState(mk('TSLA'), useMarkets.getState(), Date.now(), true)).toBe('stale');
  });

  it('tab switches during a slow poll start no second loop (F6)', async () => {
    delayMs = 1_500; // a slow API or mobile network
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(14_000);
    const before = calls;
    // The user comes back to the tab six times, 700 ms apart (each fires visibilitychange).
    for (let i = 0; i < 6; i++) {
      listeners.forEach((fn) => fn());
      await vi.advanceTimersByTimeAsync(700);
    }
    await vi.advanceTimersByTimeAsync(2_000 + 14_000 - 6 * 700);
    const after = calls - before;
    // One loop: a request every 1.5 s + 2 s. Before the fix every switch added a loop (x3 the rate).
    expect(before).toBeLessThanOrEqual(5);
    expect(after).toBeLessThanOrEqual(before + 2);
  });

  it('a slow answer that arrives after a newer one is ignored (F6)', async () => {
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(livePrice('TSLA')).toBe(W('450'));
    // The next poll is slow and would bring an older price; it is still the only request in flight,
    // so nothing newer can overtake it, and the loop goes on at its normal pace afterwards.
    delayMs = 3_000;
    body = () => MARKETS.map((m) => ({ ...base, symbol: m.symbol, name: m.name, price: m.symbol === 'TSLA' ? '451.00' : m.seedPrice, updatedAt: Date.now() }));
    await vi.advanceTimersByTimeAsync(2_000);
    const inFlight = calls;
    listeners.forEach((fn) => fn()); // visible again while the slow poll runs: no extra request
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(inFlight);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(livePrice('TSLA')).toBe(W('451'));
  });
});
