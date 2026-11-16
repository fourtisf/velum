/**
 * Final internal audit, web findings (mainnet build): W-01 strict prices and quote times, W-02 markets
 * missing from an answer, W-03 liveness from the API's flags (not the quote's age), W-07 copy that
 * follows the feed, W-11 candles, W-12 ?mode= on the server render, W-15 validated market metadata,
 * W-06 portfolio copy. The auditor's repro (zz-audit-final.mainnet.test.ts) asserted the old behaviour;
 * its cases are inverted here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

import { MARKETS, PROTOCOL, isPriceString } from '@velum/config';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MarketDTO } from '@/lib/api';
import { chartCandles } from '@/lib/candles';
import { COPY, LANDING, SIM, SOCIAL, priceSourceText, simCopy } from '@/lib/copy';
import {
  MAX_FUTURE_MS,
  apiMaxLeverage,
  apiMeta,
  apiPrice,
  apiSpark,
  livePrice,
  mk,
  priceOrigin,
  priceState,
  readApiMarket,
  startMarketFeed,
  useMarkets,
} from '@/lib/markets';
import { useApp } from '@/lib/store';
import { W } from './helpers';

vi.mock('@/components/trade/Terminal', async () => {
  const { useTradeMode } = await import('@/components/trade/mode');
  return { Terminal: () => createElement('p', null, `ticket:${useTradeMode()}`) };
});
import { TradeView } from '@/components/views/TradeView';

const NOW = 1_800_000_000_000;
const base = {
  symbol: 'TSLA',
  name: 'Tesla',
  token: null,
  status: 'live',
  price: '450.00',
  mark: '450.18',
  open24h: '445',
  change24h: '1',
  fundingPerHour: null,
  openInterest: null,
  maxLeverage: 5,
  takerFeeBps: 6,
  maintenanceMargin: '0.10',
  spark: [],
  stale: false,
  staleReason: null,
  marketOpen: true,
  quoteAge: 1,
  source: 'robinhood',
  updatedAt: NOW - 1000,
} as unknown as MarketDTO;
const read = (p: Record<string, unknown>, serverNow: number | null = NOW) => readApiMarket({ ...base, ...p } as MarketDTO, serverNow, true);

describe('W-01: only prices the API itself would accept are data', () => {
  it.each([['391.65abc'], ['1e30'], ['250,50'], ['12.5.7'], [' 450 USD'], [' 450'], ['450 '], ['+450'], ['-450'], ['0x1c2'], ['.5'], ['5.'], ['1000000000'], ['0'], ['0.000'], [''], ['NaN'], ['Infinity']])(
    '%j is no data, never a live price',
    (price) => {
      const r = read({ price });
      expect(r.noData).toBe(true);
      expect(r.price).toBeNull();
    },
  );

  it('plain decimals inside (0, 1e9) with up to 18 places are prices', () => {
    expect(read({ price: '450' })).toMatchObject({ noData: false, stale: false, price: W('450') });
    expect(apiPrice('999999999.999999999999999999')).toBe(W('999999999.999999999999999999'));
    expect(apiPrice('0.000000000000000001')).toBe(1n);
    expect(apiPrice('1.0000000000000000001')).toBeNull(); // 19 places
    expect(apiPrice(450)).toBeNull(); // a JSON number, not the documented string
  });

  it('agrees with the shared validator the API uses (packages/config isPriceString)', () => {
    const samples = ['1', '450.00', '0.5', '0', '00.0', '1e3', '1,5', ' 1', '1 ', '999999999', '1000000000', '12.5.7', '0.000000000000000001', '1.0000000000000000001', '-1', ''];
    for (const s of samples) expect([s, apiPrice(s) !== null]).toEqual([s, isPriceString(s)]);
  });

  it('a quote time more than 30 s ahead of the server is invalid, so not live', () => {
    expect(read({ updatedAt: NOW + MAX_FUTURE_MS }).stale).toBe(false);
    expect(read({ updatedAt: NOW + MAX_FUTURE_MS + 1 }).stale).toBe(true);
    expect(read({ updatedAt: NOW + 3_600_000 }).stale).toBe(true);
  });

  it('without the server time (no Date header) nothing is live', () => {
    expect(read({}, null).stale).toBe(true);
  });
});

describe("W-03: liveness is the API's word, read fail-safe", () => {
  it('a quote the API reports fresh stays live however long it has not changed', () => {
    expect(read({ updatedAt: NOW - 61_000, quoteAge: 61 }).stale).toBe(false);
    expect(read({ updatedAt: NOW - 14 * 60_000, quoteAge: 14 * 60 }).stale).toBe(false);
  });

  it('every flag must say live: stale false, staleReason null, marketOpen true', () => {
    for (const p of [{ staleReason: 'quoteFrozen' }, { staleReason: 'outdated' }, { staleReason: undefined }, { staleReason: '' }, { marketOpen: undefined }, { marketOpen: 'true' }, { stale: 'false' }, { stale: undefined }, { stale: null }])
      expect([p, read(p).stale]).toEqual([p, true]);
  });

  it('quoteAge (seconds) is informational only', () => {
    expect(read({ quoteAge: 10_000_000 }).stale).toBe(false);
    expect(read({ quoteAge: 'x' }).stale).toBe(false);
  });
});

describe('W-15: market metadata from the API is validated', () => {
  const prev = { name: 'Tesla', status: 'live' as const, token: null, maxLev: PROTOCOL.maxLeverage };
  const meta = (p: Record<string, unknown>) => apiMeta({ ...base, ...p } as MarketDTO, prev);

  it('names: plain words up to 40 characters, anything else keeps the previous name', () => {
    expect(meta({ name: 'Meta Platforms, Inc.' }).name).toBe('Meta Platforms, Inc.');
    for (const name of ['<img src=x onerror="window.__xss=1">Tesla', '', ' Tesla', 'x'.repeat(41), 'Tesla‮', 42, null]) expect(meta({ name }).name).toBe('Tesla');
  });

  it('status: one of live / coming_soon / close_only, else the previous one', () => {
    expect(meta({ status: 'close_only' }).status).toBe('close_only');
    for (const status of ['LIVE', 'open', '', null, 1]) expect(meta({ status }).status).toBe('live');
  });

  it('token: an address or null, else the previous one', () => {
    expect(meta({ token: '0x' + 'ab'.repeat(20) }).token).toBe('0x' + 'ab'.repeat(20));
    expect(meta({ token: 'javascript:window.__xss=2' }).token).toBeNull();
    expect(apiMeta({ ...base, token: '0x12' } as MarketDTO, { ...prev, token: '0x' + '11'.repeat(20) }).token).toBe('0x' + '11'.repeat(20));
  });

  it('max leverage: within 1..PROTOCOL max, on the slider step', () => {
    expect(PROTOCOL.maxLeverage).toBe(5);
    expect(apiMaxLeverage(5, 5)).toBe(5);
    expect(apiMaxLeverage(100, 5)).toBe(5);
    expect(apiMaxLeverage(2.7, 5)).toBe(2.5);
    expect(apiMaxLeverage(0.3, 5)).toBe(1);
    expect(apiMaxLeverage(-5, 5)).toBe(1);
    for (const v of [Number.NaN, Infinity, '5', null, undefined]) expect(apiMaxLeverage(v, 3)).toBe(3);
  });

  it('spark points: valid prices only, at most 60', () => {
    expect(apiSpark(['<b>1</b>', 'NaN', '-5', '1e3', '10.5'])).toEqual([10.5]);
    expect(apiSpark(Array.from({ length: 80 }, (_, i) => String(i + 1)))).toHaveLength(60);
    expect(apiSpark('1,2,3')).toEqual([]);
  });
});

describe('the feed (W-01, W-02, W-07, W-15)', () => {
  type Item = Record<string, unknown>;
  let body: () => unknown = () => [];
  let date: boolean = true;
  let down = false;
  let stop: (() => void) | undefined;
  const initial = useMarkets.getState();
  const all = (patch: (sym: string) => Item = () => ({})): Item[] =>
    MARKETS.map((m) => ({ ...base, symbol: m.symbol, name: m.name, price: m.seedPrice, updatedAt: Date.now() - 1000, ...patch(m.symbol) }));

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    useMarkets.setState({ ...initial }, true);
    body = () => all();
    date = true;
    down = false;
    (globalThis as { document?: unknown }).document = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (down) return new Response(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'down' } }), { status: 503 });
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (date) headers.date = new Date().toUTCString();
        return new Response(JSON.stringify(body()), { status: 200, headers });
      }),
    );
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('W-01: the auditor\'s malformed prices are never live; valid neighbours are', async () => {
    const bad: Record<string, Item> = { TSLA: { price: '391.65abc', mark: '391.80xyz' }, AMZN: { price: '1e30' }, PLTR: { price: '250,50' }, NFLX: { price: '12.5.7' }, AMD: { price: 150 } };
    body = () => all((s) => bad[s] ?? {});
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    for (const s of Object.keys(bad)) {
      expect([s, mk(s).noData, livePrice(s)]).toEqual([s, true, null]);
      expect(priceState(mk(s), useMarkets.getState(), Date.now(), true)).toBe('none');
    }
    expect(livePrice('NVDA')).not.toBeNull();
  });

  it('W-01: quote times an hour ahead of the server are not live', async () => {
    body = () => all(() => ({ updatedAt: Date.now() + 3_600_000 }));
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    for (const m of MARKETS) expect(livePrice(m.symbol)).toBeNull();
  });

  it('W-01: a response without a Date header makes nothing live', async () => {
    date = false;
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(mk('TSLA').noData).toBe(false);
    expect(livePrice('TSLA')).toBeNull();
  });

  it('W-02: a market missing from a successful answer has no data until it comes back', async () => {
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(livePrice('TSLA')).toBe(W('391.65'));
    body = () => all().filter((m) => m.symbol !== 'TSLA');
    await vi.advanceTimersByTimeAsync(75_000);
    expect(mk('TSLA').noData).toBe(true);
    expect(livePrice('TSLA')).toBeNull();
    expect(priceState(mk('TSLA'), useMarkets.getState(), Date.now(), true)).toBe('none');
    expect(livePrice('AMZN')).toBe(W('233.40'));
    body = () => all();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(livePrice('TSLA')).toBe(W('391.65'));
  });

  it('W-02: an empty answer, junk entries, unknown symbols and repeats do not keep or invent prices', async () => {
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    body = () => [null, 7, 'TSLA', { ...base, symbol: '__proto__' }, { ...base, symbol: 'XYZ' }, { ...base, symbol: 'AMZN', price: '240.00' }, { ...base, symbol: 'AMZN', price: '1.00' }];
    await vi.advanceTimersByTimeAsync(2_000);
    expect(livePrice('TSLA')).toBeNull();
    expect(livePrice('AMZN')).toBe(W('240')); // the first entry for a symbol counts
    expect(Object.prototype.hasOwnProperty.call(useMarkets.getState().bySym, 'XYZ')).toBe(false);
    body = () => [];
    await vi.advanceTimersByTimeAsync(2_000);
    for (const m of MARKETS) expect(livePrice(m.symbol)).toBeNull();
  });

  it('W-15: hostile metadata never reaches the store', async () => {
    body = () =>
      all(() => ({ name: '<img src=x onerror="window.__xss=1">Tesla', token: 'javascript:window.__xss=2', status: 'pwned', maxLeverage: 50, spark: ['<b>1</b>', 'NaN', '-5'], change24h: '<script>' }));
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    const t = mk('TSLA');
    expect([t.name, t.token, t.status, t.maxLev]).toEqual(['Tesla', MARKETS[0]!.token?.address ?? null, MARKETS[0]!.status, 5]);
    expect(t.hist.every((n) => Number.isFinite(n) && n > 0)).toBe(true);
    expect(Number.isFinite(t.chg)).toBe(true);
  });

  it('W-07: with the API down from page load the copy says unavailable, not "Loading" forever', async () => {
    down = true;
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(priceOrigin(useMarkets.getState())).toBe('loading'); // one failure: still loading
    await vi.advanceTimersByTimeAsync(2_000);
    expect(priceOrigin(useMarkets.getState())).toBe('none');
    expect(COPY.frameCap(priceOrigin(useMarkets.getState()), false)).toMatch(/^Live prices are unavailable right now\./);
    down = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(priceOrigin(useMarkets.getState())).toBe('robinhood');
  });

  it('W-07: the API failing mid-session drops the source claim; every market closed says so', async () => {
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(priceOrigin(useMarkets.getState())).toBe('robinhood');
    down = true;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(priceOrigin(useMarkets.getState())).toBe('none');
    down = false;
    body = () => all(() => ({ stale: true, staleReason: 'marketClosed', marketOpen: false, updatedAt: Date.now() - 40 * 3600e3, quoteAge: 40 * 3600 }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(priceOrigin(useMarkets.getState())).toBe('closed');
    expect(priceSourceText('closed')).toBe('The stock market is closed: prices shown are the last quotes.');
    // One market open again: the source is named.
    body = () => all((s) => (s === 'TSLA' ? {} : { stale: true, staleReason: 'marketClosed', marketOpen: false }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(priceOrigin(useMarkets.getState())).toBe('robinhood');
  });
});

describe('W-07 / DV-F3 / W-06: copy', () => {
  it('the footer makes no claim about prices', () => {
    expect(COPY.footer).not.toMatch(/live/i);
    expect(COPY.footer.startsWith(COPY.brand)).toBe(true);
  });

  it('freeze copy says what Velum controls and that issuers can freeze', () => {
    expect(LANDING.freezeTitle).toBe("Designed so Velum can't freeze your funds");
    expect(LANDING.freezeText).toMatch(/^No Velum key can freeze or withdraw funds, by design\./);
    expect(LANDING.freezeText).toMatch(/Token issuers can still freeze their tokens/);
    expect(LANDING.statAdmin).toBe('Velum keys that can freeze or withdraw funds, by design');
    expect(LANDING.freezeBigNote).toBe('freeze keys');
  });

  it('mainnet portfolio headline is the simulated practice balance; the demo address receives nothing', () => {
    expect(SIM.balanceLabel).toBe('Practice balance');
    expect(SIM.balanceBadge).toBe(true);
    expect(SIM.accountBadge).toBe('Simulated');
    expect(SIM.paddrNote).not.toMatch(/receive/i);
    // Testnet keeps the prototype's words.
    expect(simCopy(false).balanceLabel).toBe('Private balance');
    expect(simCopy(false).balanceBadge).toBe(false);
    expect(simCopy(false).paddrNote).toBe('Share this address to receive private transfers.');
  });
});

describe("Velum on X (owner request): one constant, the owner's exact URL", () => {
  it('URL, handle and accessible name', () => {
    expect(SOCIAL).toEqual({ x: 'https://x.com/velumtrade', xHandle: '@velumtrade', xLabel: 'Velum on X' });
  });
});

describe('W-11: chart candles', () => {
  const ok = (t: number, o = '10', h = '11', l = '9', c = '10.5') => ({ t, o, h, l, c });

  it("the auditor's malformed candles are all dropped (the chart then says unavailable)", () => {
    expect(chartCandles(Array.from({ length: 5 }, () => ({ t: 'x', o: 'NaN', h: null, l: '-', c: 'abc' })))).toEqual([]);
  });

  it('drops each malformed candle and keeps the valid ones, oldest first, one per bucket', () => {
    const list = [ok(3000), ok(1000), { ...ok(2000), h: '1e3' }, ok(1000, '12', '13', '11', '12'), { ...ok(4000), l: '10.6' }, { ...ok(5000), h: '10.4' }, ok(-1), ok(1.5), null, 'x', ok(6000)];
    expect(chartCandles(list)).toEqual([
      { t: 1000, o: 12, h: 13, l: 11, c: 12 },
      { t: 3000, o: 10, h: 11, l: 9, c: 10.5 },
      { t: 6000, o: 10, h: 11, l: 9, c: 10.5 },
    ]);
  });

  it('anything but an array gives none', () => {
    for (const v of [null, undefined, {}, 'candles', 42]) expect(chartCandles(v)).toEqual([]);
  });
});

describe('W-10: error pages carry the brand line', () => {
  it('app/error.tsx and app/global-error.tsx', async () => {
    const { default: ErrorPage } = await import('@/app/error');
    const { default: GlobalError } = await import('@/app/global-error');
    const props = { error: new Error('x'), reset: () => undefined };
    expect(renderToStaticMarkup(createElement(ErrorPage, props))).toContain(COPY.brand);
    expect(renderToStaticMarkup(createElement(GlobalError, props))).toContain(COPY.brand);
  });
});

describe('W-12: ?mode= on the server render', () => {
  const html = (mode?: 'spot' | 'perps') => renderToStaticMarkup(createElement(TradeView, { symbol: 'TSLA', mode }));

  it('the server render shows the URL mode, not the store default', () => {
    expect(useApp.getState().mode).toBe('perps');
    expect(html('spot')).toContain('ticket:spot');
    expect(html('perps')).toContain('ticket:perps');
    expect(html()).toContain('ticket:perps');
  });
});
