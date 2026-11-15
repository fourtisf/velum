/**
 * Audit round 2, M4 (mainnet build): no seed or stale price ever reaches money logic.
 * Covers the price helper, every place that values or trades, and the live feed itself
 * (startMarketFeed with a mocked API) with the API down from page load and going down mid-session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

import { IS_MAINNET, MARKETS } from '@velum/config';
import { inPos, perpsCalc, posPnl, privTotal, spotCalc, swapCalc, valueOf } from '@/lib/calc';
import { PRICE_GONE, checkLiq, closePos, doSwap, lpGo, openPerps, spotTrade } from '@/lib/demo';
import {
  PRICE_MAX_AGE_MS,
  STALE_AFTER_FAILURES,
  feedIsStale,
  livePrice,
  mk,
  priceState,
  startMarketFeed,
  tokPx,
  tradablePrice,
  useMarkets,
  type LiveMarket,
} from '@/lib/markets';
import { emptyLedger, seedLedger, useApp, type Ledger } from '@/lib/store';
import { W, connect, installStorage, patchMarket, setLiveMarkets, takeFlow } from './helpers';

const initialMarkets = useMarkets.getState();
const initialApp = useApp.getState();

beforeEach(() => {
  installStorage();
  useMarkets.setState({ ...initialMarkets }, true);
  useApp.setState({ ...initialApp, ledger: emptyLedger(), account: null, modal: null, modalLocked: false, toasts: [] }, true);
});

it('runs as a mainnet build', () => expect(IS_MAINNET).toBe(true));

describe('the price rule (tradablePrice)', () => {
  const m = { price: W('450'), noData: false, stale: false } as LiveMarket;
  const fresh = { lastOkAt: 1_000_000, failures: 0, feedStale: false };
  const now = 1_000_000 + 5_000;

  it('no live data (API source null) means no price on either network', () => {
    expect(tradablePrice({ ...m, noData: true }, fresh, now, true)).toBeNull();
    expect(tradablePrice({ ...m, noData: true }, fresh, now, false)).toBeNull();
    expect(tradablePrice(undefined, fresh, now, true)).toBeNull();
    expect(tradablePrice({ ...m, price: 0n }, fresh, now, false)).toBeNull();
  });

  it('mainnet: a fresh price is tradable; stale market, stale feed, failures, age or no poll yet are not', () => {
    expect(tradablePrice(m, fresh, now, true)).toBe(W('450'));
    expect(tradablePrice({ ...m, stale: true }, fresh, now, true)).toBeNull();
    expect(tradablePrice(m, { ...fresh, feedStale: true }, now, true)).toBeNull();
    expect(tradablePrice(m, { ...fresh, failures: STALE_AFTER_FAILURES }, now, true)).toBeNull();
    expect(tradablePrice(m, { ...fresh, failures: STALE_AFTER_FAILURES - 1 }, now, true)).toBe(W('450'));
    expect(tradablePrice(m, fresh, fresh.lastOkAt + PRICE_MAX_AGE_MS, true)).toBe(W('450'));
    expect(tradablePrice(m, fresh, fresh.lastOkAt + PRICE_MAX_AGE_MS + 1, true)).toBeNull();
    expect(tradablePrice(m, { ...fresh, lastOkAt: null }, now, true)).toBeNull();
  });

  it('testnet keeps the prototype: staleness does not block the demo', () => {
    expect(tradablePrice({ ...m, stale: true }, { lastOkAt: null, failures: 9, feedStale: true }, now, false)).toBe(W('450'));
  });

  it('feed staleness: repeated failures or a minute without success', () => {
    expect(STALE_AFTER_FAILURES).toBe(2);
    expect(PRICE_MAX_AGE_MS).toBe(60_000);
    expect(feedIsStale({ lastOkAt: null, failures: 0 }, now)).toBe(false);
    expect(feedIsStale({ lastOkAt: null, failures: 2 }, now)).toBe(true);
    expect(feedIsStale({ lastOkAt: now - 60_001, failures: 0 }, now)).toBe(true);
    expect(feedIsStale({ lastOkAt: now - 59_000, failures: 1 }, now)).toBe(false);
  });

  it('display state: none (dash), stale (marked) or live', () => {
    expect(priceState({ ...m, noData: true }, fresh, now, true)).toBe('none');
    expect(priceState({ ...m, stale: true }, fresh, now, true)).toBe('stale');
    expect(priceState(m, { ...fresh, feedStale: true }, now, true)).toBe('stale');
    expect(priceState(m, fresh, now, true)).toBe('live');
    expect(priceState({ ...m, stale: true }, { ...fresh, feedStale: true }, now, false)).toBe('live');
  });
});

describe('before any price arrives (seed state)', () => {
  it('no market has a price; the seed is never tradable', () => {
    for (const m of MARKETS) {
      expect(mk(m.symbol).noData).toBe(true);
      expect(livePrice(m.symbol)).toBeNull();
      expect(tokPx(m.symbol)).toBeNull();
    }
    expect(tokPx('USDG')).toBe(W('1'));
    expect(tokPx('ETH')).toBeNull();
  });

  it('quotes say they have no price', () => {
    expect(perpsCalc({ sel: 'TSLA', side: 'long', lev: 2, size: '500' }, W('1000')).priced).toBe(false);
    const sp = spotCalc({ sel: 'TSLA', spotSide: 'buy', spotAmt: '500', slip: 0.5 }, {});
    expect(sp.priced).toBe(false);
    expect(sp.out).toBe(0n);
    expect(swapCalc('USDG', 'TSLA', '100', 0.5, {}).priced).toBe(false);
    expect(swapCalc('TSLA', 'AMZN', '1', 0.5, {}).priced).toBe(false);
  });
});

describe('valuations (privTotal, valueOf, posPnl, inPos)', () => {
  const pos = { id: 'p1', sym: 'TSLA', side: 'long' as const, lev: 2, margin: W('200'), qty: W('1'), entry: W('400'), liq: W('222'), cs: W('0.0005'), commit: '0x' + '0'.repeat(64), block: 0, openedAt: 1_800_000_000_000 };
  const ledger = (over: Partial<Ledger> = {}): Ledger => ({ ...emptyLedger(), priv: { USDG: W('1000') }, ...over });

  it('free USDG needs no price', () => {
    expect(privTotal(seedLedger())).toBe(W('10000'));
    expect(privTotal(ledger({ priv: { USDG: W('1000'), TSLA: 0n } }))).toBe(W('1000'));
  });

  it('an unpriced holding makes the total unknown (a dash), never a seed-valued number', () => {
    expect(valueOf('TSLA', W('2'))).toBeNull();
    expect(privTotal(ledger({ priv: { USDG: W('1000'), TSLA: W('2') } }))).toBeNull();
    expect(posPnl(pos)).toBeNull();
    expect(inPos(ledger({ positions: [pos] }))).toBeNull();
    expect(privTotal(ledger({ positions: [pos] }))).toBeNull();
  });

  it('with live prices everything is valued', () => {
    setLiveMarkets({ TSLA: '450' });
    expect(valueOf('TSLA', W('2'))).toBe(W('900'));
    expect(posPnl(pos)).toBe(W('50'));
    expect(inPos(ledger({ positions: [pos] }))).toBe(W('250'));
    expect(privTotal(ledger({ priv: { USDG: W('1000'), TSLA: W('2') }, positions: [pos], lp: { TSLA: W('10') } }))).toBe(W('2160'));
  });

  it('a stale feed un-values everything priced', () => {
    setLiveMarkets({ TSLA: '450' });
    useMarkets.setState({ feedStale: true });
    expect(valueOf('TSLA', W('2'))).toBeNull();
    expect(posPnl(pos)).toBeNull();
  });
});

describe('trades re-check the price when the flow completes', () => {
  const ready = () => {
    connect(seedLedger());
    setLiveMarkets({ TSLA: '450' });
    useApp.setState({ sel: 'TSLA', size: '500', lev: 2, side: 'long', spotSide: 'buy', spotAmt: '500', swapFrom: 'USDG', swapTo: 'TSLA', swapAmt: '100' });
  };
  const lose = {
    'market has no data': () => patchMarket('TSLA', { noData: true }),
    'API marks it stale': () => patchMarket('TSLA', { stale: true }),
    'feed failing': () => useMarkets.setState({ failures: 2, feedStale: true }),
    'no success for a minute': () => useMarkets.setState({ lastOkAt: Date.now() - PRICE_MAX_AGE_MS - 1 }),
  };

  for (const [why, drop] of Object.entries(lose)) {
    it(`${why}: open, spot, swap and add liquidity are cancelled and change nothing`, () => {
      for (const start of [openPerps, spotTrade, doSwap, () => lpGo('TSLA', W('1000'))]) {
        ready();
        const before = useApp.getState().ledger;
        start();
        const f = takeFlow();
        drop();
        expect(f.done()).toEqual(PRICE_GONE);
        expect(useApp.getState().ledger).toBe(before);
      }
    });

    it(`${why}: close is not started, and a running close keeps the position open`, () => {
      ready();
      openPerps();
      takeFlow().done();
      const [p] = useApp.getState().ledger.positions;
      expect(p).toBeDefined();
      // A running close whose price disappears before it settles.
      closePos(p!.id);
      const f = takeFlow();
      drop();
      expect(f.done()).toEqual(PRICE_GONE);
      expect(useApp.getState().ledger.positions.map((x) => x.id)).toEqual([p!.id]);
      // And with the price gone, Close starts nothing.
      closePos(p!.id);
      expect(useApp.getState().modal).toBeNull();
    });
  }

  it('without a price no flow starts at all', () => {
    connect(seedLedger());
    useApp.setState({ sel: 'TSLA', size: '500', swapFrom: 'USDG', swapTo: 'TSLA', swapAmt: '100' });
    for (const start of [openPerps, spotTrade, doSwap, () => lpGo('TSLA', W('1000'))]) {
      start();
      expect(useApp.getState().modal).toBeNull();
    }
  });

  it('with a live price the trade goes through at that price', () => {
    ready();
    openPerps();
    const r = takeFlow().done();
    expect(r.toast).toBe('Long opened on TSLA');
    expect(useApp.getState().ledger.positions[0]!.entry).toBe(W('450.225')); // 450 + 5 bps maker spread
  });
});

describe('liquidation skips markets without a live price', () => {
  it('a stale or missing price never liquidates; a live one does', () => {
    connect(seedLedger());
    setLiveMarkets({ TSLA: '400' });
    useApp.setState({ sel: 'TSLA', size: '1000', lev: 5, side: 'long' });
    openPerps();
    takeFlow().done();
    expect(useApp.getState().ledger.positions).toHaveLength(1);
    // Far below the liquidation price, but not a live price: nothing happens.
    patchMarket('TSLA', { price: W('300'), stale: true });
    checkLiq();
    patchMarket('TSLA', { stale: false, noData: true });
    checkLiq();
    useMarkets.setState({ feedStale: true });
    patchMarket('TSLA', { noData: false });
    checkLiq();
    expect(useApp.getState().ledger.positions).toHaveLength(1);
    // The same price, live: liquidated.
    useMarkets.setState({ feedStale: false, failures: 0, lastOkAt: Date.now() });
    checkLiq();
    expect(useApp.getState().ledger.positions).toHaveLength(0);
    expect(useApp.getState().ledger.history[0]!.title).toBe('Liquidated long TSLA');
  });
});

describe('the live feed (startMarketFeed) on mainnet', () => {
  type Mode = 'live' | 'nodata' | 'stale' | 'down';
  let mode: Mode = 'live';
  let stop: (() => void) | undefined;
  const dto = (symbol: string, seed: string) => {
    const nd = mode === 'nodata' && symbol === 'TSLA';
    const price = nd ? seed : symbol === 'TSLA' ? '450.00' : seed;
    return {
      symbol,
      name: symbol,
      token: null,
      status: 'live',
      price,
      mark: price,
      open24h: price,
      change24h: '0.00',
      fundingPerHour: '0.0042',
      openInterest: '1',
      maxLeverage: 5,
      takerFeeBps: 6,
      maintenanceMargin: '0.10',
      spark: [price],
      stale: nd || mode === 'stale',
      staleReason: nd ? 'noPrice' : mode === 'stale' ? 'outdated' : null,
      marketOpen: true,
      quoteAge: nd ? null : 0,
      source: nd ? null : 'robinhood',
      updatedAt: nd ? null : Date.now(),
    };
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    mode = 'live';
    (globalThis as { document?: unknown }).document = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (mode === 'down') throw new TypeError('Failed to fetch');
        // The server's Date header (like Nginx / Fastify): mainnet needs it to check quote times.
        return new Response(JSON.stringify(MARKETS.map((m) => dto(m.symbol, m.seedPrice))), { status: 200, headers: { 'content-type': 'application/json', date: new Date().toUTCString() } });
      }),
    );
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('API down from page load: no price anywhere, feed stale, no simulated fallback', async () => {
    mode = 'down';
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(useMarkets.getState().failures).toBe(1);
    expect(useMarkets.getState().feedStale).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(useMarkets.getState().failures).toBe(2);
    expect(useMarkets.getState().feedStale).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    const s = useMarkets.getState();
    expect(s.source).toBe('seed'); // never the local random walk on mainnet
    for (const m of MARKETS) {
      expect(s.bySym[m.symbol]!.noData).toBe(true);
      expect(livePrice(m.symbol)).toBeNull();
    }
  });

  it('API goes down mid-session: prices turn stale after repeated failures and come back with the API', async () => {
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(livePrice('TSLA')).toBe(W('450'));
    expect(useMarkets.getState().lastOkAt).toBe(Date.now());
    mode = 'down';
    await vi.advanceTimersByTimeAsync(2000);
    expect(useMarkets.getState().failures).toBe(1);
    expect(livePrice('TSLA')).toBe(W('450')); // one blip is tolerated
    await vi.advanceTimersByTimeAsync(2000);
    expect(useMarkets.getState().feedStale).toBe(true);
    expect(livePrice('TSLA')).toBeNull();
    expect(priceState(mk('TSLA'), useMarkets.getState(), Date.now(), true)).toBe('stale');
    expect(mk('TSLA').price).toBe(W('450')); // the last real price is kept for display, marked stale
    mode = 'live';
    await vi.advanceTimersByTimeAsync(2000);
    expect(useMarkets.getState().feedStale).toBe(false);
    expect(livePrice('TSLA')).toBe(W('450'));
  });

  it('a market losing its data never takes the seed price the API sends with source null', async () => {
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(livePrice('TSLA')).toBe(W('450'));
    mode = 'nodata';
    await vi.advanceTimersByTimeAsync(2000);
    expect(mk('TSLA').noData).toBe(true);
    expect(mk('TSLA').price).toBe(W('450')); // not 391.65 (the seed)
    expect(livePrice('TSLA')).toBeNull();
    expect(livePrice('AMZN')).toBe(W('233.40'));
  });

  it('a price the API marks stale is not tradable', async () => {
    mode = 'stale';
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(mk('TSLA').noData).toBe(false);
    expect(livePrice('TSLA')).toBeNull();
  });

  it('no successful poll for over a minute marks the feed stale even without counted failures', async () => {
    stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(0);
    // Simulate a stalled poll loop (e.g. a throttled background tab): last success 61 s ago.
    useMarkets.setState({ lastOkAt: Date.now() - 61_000, failures: 0 });
    expect(livePrice('TSLA')).toBeNull(); // money logic checks the age itself
    await vi.advanceTimersByTimeAsync(2000); // next poll succeeds again
    expect(livePrice('TSLA')).toBe(W('450'));
  });
});
