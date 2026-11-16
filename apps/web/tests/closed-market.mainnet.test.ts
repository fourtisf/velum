/**
 * Closed-market display (mainnet build): the change's basis label, the on-chain DEX price (display only), the chart's
 * session layout (closed time compressed, session separators, DEX candles) and the perps hint on dashes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

import { IS_MAINNET } from '@velum/config';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChgText, PerpsDash, dexTipText } from '@/components/ui';
import { chartCandles, chartLayout, readoutTime, type ChartCandle } from '@/lib/candles';
import { PERPS_HINT } from '@/lib/copy';
import { changeView, livePrice, readApiMarket, readClosedFields, useMarkets, type LiveMarket } from '@/lib/markets';
import type { MarketDTO } from '@/lib/api';
import { W, patchMarket } from './helpers';

const Z = (s: string) => Date.parse(s);
const H = 3_600_000;
const initial = useMarkets.getState();
beforeEach(() => useMarkets.setState({ ...initial }, true));

it('runs as a mainnet build', () => expect(IS_MAINNET).toBe(true));

const dto = (over: Partial<MarketDTO> = {}): MarketDTO =>
  ({
    symbol: 'NVDA',
    name: 'Nvidia',
    token: null,
    status: 'live',
    price: '155.145',
    mark: '155.2',
    open24h: '155.145',
    change24h: '0.00',
    fundingPerHour: null,
    openInterest: null,
    maxLeverage: 5,
    takerFeeBps: 6,
    maintenanceMargin: '0.10',
    spark: ['155.145'],
    stale: true,
    staleReason: 'marketClosed',
    marketOpen: false,
    source: 'robinhood',
    updatedAt: Z('2026-11-14T00:59:58Z'),
    change: '3.43',
    changeBasis: 'lastSession',
    lastSession: { tradingDay: '2026-11-13', end: Z('2026-11-14T01:00:00Z'), close: '155.145', prevClose: '150', change: '3.43' },
    dex: null,
    ...over,
  }) as MarketDTO;

describe('closed-market fields from the API', () => {
  it('closed: the last session change replaces the frozen 24 h; still never tradable', () => {
    const r = readApiMarket(dto(), Z('2026-11-15T17:00:00Z'), true);
    expect(r).toMatchObject({ closed: true, stale: true });
    expect(readClosedFields(dto(), true)).toEqual({ chgBasis: 'lastSession', sessionChg: 3.43, dex: null });
  });

  it('closed without a stored close: a null change (shown as a dash), never the 24 h figure', () => {
    expect(readClosedFields(dto({ lastSession: { tradingDay: '2026-11-13', close: null, prevClose: null, change: null } }), true).sessionChg).toBeNull();
    expect(readClosedFields(dto({ lastSession: { change: '12abc' } }), true).sessionChg).toBeNull();
  });

  it('open (or an API without lastSession): the rolling 24 h exactly as before', () => {
    expect(readClosedFields(dto({ marketOpen: true, staleReason: null, stale: false }), false)).toEqual({ chgBasis: '24h', sessionChg: null, dex: null });
    expect(readClosedFields(dto({ lastSession: undefined }), true)).toEqual({ chgBasis: '24h', sessionChg: null, dex: null });
  });

  it('a valid dex block becomes the on-chain DEX price; a malformed one is dropped', () => {
    const pool = '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3';
    const dex = { price: '161.27', change: '0.11', closeRef: '161.1', closeAt: Z('2026-11-14T00:58:00Z'), tradeAt: Z('2026-11-15T16:55:00Z'), block: 115_100_000, pool, liquidityUsdg: '1922052.5' };
    const f = readClosedFields(dto({ changeBasis: 'dexSinceClose', change: '0.11', dex }), true);
    expect(f.dex).toMatchObject({ price: W('161.27'), priceNum: 161.27, chg: 0.11, closeRef: 161.1, pool, liquidity: 1922052.5, tradeAt: Z('2026-11-15T16:55:00Z') });
    expect(readClosedFields(dto({ dex: { ...dex, change: null, closeRef: null } }), true).dex).toMatchObject({ chg: null, closeRef: null });
    expect(readClosedFields(dto({ dex: { ...dex, pool: 'not-an-address' } }), true).dex).toBeNull();
    expect(readClosedFields(dto({ dex: { ...dex, price: '1e3' } }), true).dex).toBeNull();
    // Never while open.
    expect(readClosedFields(dto({ dex }), false).dex).toBeNull();
  });

  it('the DEX price is never a price money logic can read', () => {
    patchMarket('NVDA', { noData: false, stale: true, closed: true, price: W('155.145'), dex: { price: W('161.27'), priceNum: 161.27, chg: 3.95, closeRef: null, pool: '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3', liquidity: 1, tradeAt: null } });
    useMarkets.setState({ lastOkAt: Date.now(), failures: 0, feedStale: false });
    expect(livePrice('NVDA')).toBeNull();
  });
});

describe('change label', () => {
  const m = (over: Partial<LiveMarket>): LiveMarket => ({ ...useMarkets.getState().bySym.TSLA!, noData: false, chg: 0, chgBasis: '24h', sessionChg: null, dex: null, ...over });
  let current: LiveMarket;
  const patch = (_sym: string, mk: LiveMarket) => (current = mk);
  const html = (_sym: string, dex = false) => renderToStaticMarkup(createElement(ChgText, { m: current, dex }));

  it('changeView picks the basis', () => {
    const dex = { price: W('161.27'), priceNum: 161.27, chg: 3.95, closeRef: null, pool: '0x' + '1'.repeat(40), liquidity: null, tradeAt: null };
    expect(changeView({ chg: 0, chgBasis: 'lastSession', sessionChg: -1.24, dex: null })).toEqual({ value: -1.24, basis: 'lastSession' });
    expect(changeView({ chg: 0, chgBasis: 'lastSession', sessionChg: -1.24, dex }, true)).toEqual({ value: 3.95, basis: 'dex' });
    expect(changeView({ chg: 0, chgBasis: 'lastSession', sessionChg: -1.24, dex }, false)).toEqual({ value: -1.24, basis: 'lastSession' });
    expect(changeView({ chg: 1.41, chgBasis: '24h', sessionChg: null, dex: null }, true)).toEqual({ value: 1.41, basis: '24h' });
  });

  it('"-1.24% · last session" with the usual colors; a missing change is a dash with the label', () => {
    patch('TSLA', m({ chgBasis: 'lastSession', sessionChg: -1.24 }));
    expect(html('TSLA')).toBe('<span class="down">-1.24%<span class="chg-basis">· last session</span></span>');
    patch('TSLA', m({ chgBasis: 'lastSession', sessionChg: null }));
    expect(html('TSLA')).toBe('<span class="">—<span class="chg-basis">· last session</span></span>');
  });

  it('with the DEX price: "+3.95% · since close"; open: the plain 24 h as before', () => {
    patch('NVDA', m({ chgBasis: 'lastSession', sessionChg: 3.43, dex: { price: W('161.27'), priceNum: 161.27, chg: 3.95, closeRef: 155.3, pool: '0x' + '1'.repeat(40), liquidity: null, tradeAt: null } }));
    expect(html('NVDA', true)).toBe('<span class="up">+3.95%<span class="chg-basis">· since close</span></span>');
    // The strip chip (compact): the DEX tag is beside it, no label.
    expect(renderToStaticMarkup(createElement(ChgText, { m: current, dex: true, compact: true }))).toBe('<span class="up">+3.95%</span>');
    expect(html('NVDA', false)).toContain('+3.43%<span class="chg-basis">· last session</span>');
    patch('AAPL', m({ chg: 1.41 }));
    expect(html('AAPL', true)).toBe('<span class="up">+1.41%</span>');
  });

  it('the DEX tooltip names only the pool address and its liquidity (no DEX brand)', () => {
    const t = dexTipText({ price: W('161.27'), priceNum: 161.27, chg: 0.11, closeRef: 161.1, pool: '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3', liquidity: 1922052.5, tradeAt: 1_000_000 }, 1_000_000 + 300_000);
    expect(t).toBe('On-chain DEX price, display only · Pool 0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3 · Liquidity $1.9M · Last trade 5 min ago · At the close 161.10');
  });
});

describe('perps hint on mainnet dashes', () => {
  it('a focusable dash described by a tooltip "Live when perps launch"', () => {
    const out = renderToStaticMarkup(createElement(PerpsDash));
    const id = /aria-describedby="([^"]+)"/.exec(out)![1]!;
    expect(out).toContain('tabindex="0"');
    expect(out).toContain(`role="tooltip" id="${id}"`);
    expect(out).toContain(`>${PERPS_HINT}<`);
    expect(out).toContain('>—<');
  });
  it('table cells: no tab stop, a title and screen-reader text', () => {
    const out = renderToStaticMarkup(createElement(PerpsDash, { inline: true }));
    expect(out).not.toContain('tabindex');
    expect(out).toBe(`<span title="${PERPS_HINT}">—<span class="sr"> ${PERPS_HINT}</span></span>`);
  });
});

describe('chart session layout (pure)', () => {
  const k = (t: number, o: number, h = o, l = o, c = o, src?: 'dex'): ChartCandle => ({ t, o, h, l, c, ...(src ? { src } : {}) });
  // Friday Nov 13, 2026, last three open hours (EST), then the frozen weekend, then Monday's session from Sunday 20:00.
  const fri = Z('2026-11-13T22:00:00Z');
  const weekend: ChartCandle[] = [];
  for (let t = fri + 3 * H; t < Z('2026-11-16T01:00:00Z'); t += H) weekend.push(k(t, 391.65));
  const mon = Z('2026-11-16T01:00:00Z');
  const series = [k(fri, 390, 391, 389.5, 390.5), k(fri + H, 390.5, 392, 390, 391.9), k(fri + 2 * H, 391.9, 392, 391, 391.65), ...weekend, k(mon, 391.65, 393, 391, 392.5), k(mon + H, 392.5, 393.4, 392, 393)];

  it('compresses closed time that only repeats the last price; separates the sessions', () => {
    const lay = chartLayout(series, '1h');
    expect(lay.list.map((c) => c.t)).toEqual([fri, fri + H, fri + 2 * H, mon, mon + H]);
    expect(lay.breaks).toEqual([3]); // Friday's session | Monday's session (the weekend left out)
    expect(lay.hasDex).toBe(false);
  });

  it('separators at every session boundary while open (20:00 New York, across the DST change)', () => {
    // Thursday Oct 29 to Friday Oct 30, 2026 (EDT): the boundary is 00:00 UTC.
    const hours = Array.from({ length: 30 }, (_, i) => k(Z('2026-10-29T12:00:00Z') + i * H, 100 + i, 101 + i, 99 + i, 100.5 + i));
    expect(chartLayout(hours, '1h').breaks).toEqual([12]); // 2026-10-30T00:00Z
    // Monday Nov 2 after DST ended (EST): 01:00 UTC.
    const est = Array.from({ length: 30 }, (_, i) => k(Z('2026-11-02T12:00:00Z') + i * H, 100 + i, 101 + i, 99 + i, 100.5 + i));
    expect(chartLayout(est, '1h').breaks).toEqual([13]); // 2026-11-03T01:00Z
  });

  it('keeps the on-chain DEX candles of the closed period, and the legend shows', () => {
    const withDex = [...series.slice(0, 3), k(Z('2026-11-14T10:00:00Z'), 160, 161, 159.5, 160.8, 'dex'), k(Z('2026-11-14T11:00:00Z'), 160.8, 160.8, 160.8, 160.8, 'dex'), ...series.slice(-2)];
    const lay = chartLayout(withDex, '1h');
    expect(lay.list.map((c) => c.src ?? 'quote')).toEqual(['quote', 'quote', 'quote', 'dex', 'dex', 'quote', 'quote']);
    expect(lay.hasDex).toBe(true);
    expect(lay.breaks).toEqual([3, 5]); // into the closed period (Saturday's day), and Monday's session
  });

  it('1D: one candle per trading day, no separators', () => {
    const days = [k(Z('2026-11-12T00:00:00Z'), 380, 386, 379, 385.75), k(Z('2026-11-13T00:00:00Z'), 386, 393, 385, 392), k(Z('2026-11-16T00:00:00Z'), 392, 395, 390, 394)];
    expect(chartLayout(days, '1D')).toEqual({ list: days, breaks: [], hasDex: false });
  });

  it('reads `src` and `end` from the API, validated', () => {
    const got = chartCandles([
      { t: 1000, o: '1', h: '2', l: '1', c: '2', src: 'dex', end: 5000 },
      { t: 2000, o: '1', h: '2', l: '1', c: '2', src: 'other', end: 'x' },
      { t: 3000, o: '1', h: '2', l: '1', c: '2', src: 'dex', end: 100 },
    ]);
    expect(got).toEqual([
      { t: 1000, o: 1, h: 2, l: 1, c: 2, src: 'dex', end: 5000 },
      { t: 2000, o: 1, h: 2, l: 1, c: 2 },
      { t: 3000, o: 1, h: 2, l: 1, c: 2, src: 'dex' },
    ]);
  });

  it('readout shows real timestamps: daily dates as trading days (UTC), DEX periods with their range', () => {
    expect(readoutTime(k(Z('2026-11-13T00:00:00Z'), 1), '1D', 'en-US', 'America/New_York')).toBe('Nov 13');
    expect(readoutTime(k(Z('2026-11-14T15:00:00Z'), 1), '1h', 'en-US', 'UTC')).toBe('Nov 14, 03:00 PM');
    expect(readoutTime(k(Z('2026-11-14T15:00:00Z'), 1, 1, 1, 1, 'dex'), '1h', 'en-US', 'UTC')).toBe('On-chain DEX · Nov 14, 03:00 PM');
    const period = { ...k(Z('2026-11-14T01:00:00Z'), 1, 1, 1, 1, 'dex'), end: Z('2026-11-16T01:00:00Z') };
    expect(readoutTime(period, '1D', 'en-US', 'America/New_York')).toBe('On-chain DEX · Nov 13, 08:00 PM – Nov 15, 08:00 PM');
  });
});
