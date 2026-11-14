'use client';
/**
 * Live market data. Source of truth is the API (/v1/markets, polled every 2 s).
 * Before the first response we render the config seed (deterministic, so SSR matches).
 * In demo mode only, if the API is unreachable the browser runs the prototype's random walk
 * so the demo keeps working; it switches back as soon as the API answers (testnet only).
 *
 * Money logic never reads `price` directly: it asks livePrice(), which returns null when a market
 * has no live price (API source null) or, on mainnet, when the price or the feed is stale
 * (audit round 2, M4). The config seed is never a tradable price where the API has none.
 */
import { IS_MAINNET, MARKETS, type MarketStatus } from '@velum/config';
import { fromNumber, parseWad, toNumber, type Wad } from '@velum/math';
import { create } from 'zustand';
import { api, type MarketDTO } from './api';
import { ENV } from './env';

export interface LiveMarket {
  sym: string;
  name: string;
  status: MarketStatus;
  token: string | null;
  price: Wad;
  priceNum: number;
  mark: Wad;
  open: Wad;
  /** 24h change in percent (display only). */
  chg: number;
  /** Funding per hour in percent, e.g. 0.0042. */
  funding: number;
  oi: number;
  maxLev: number;
  /** Last-hour sparkline, oldest first (display only). */
  hist: number[];
  dir: 1 | -1;
  stale: boolean;
  /** Price source reported by the API: 'demo' (simulated), 'robinhood' or 'chainlink'. */
  priceSource: string;
  /** No live price: the API reports none (source null) or, on mainnet, nothing has arrived yet. Displayed as a dash. */
  noData: boolean;
}

export type FeedSource = 'seed' | 'api' | 'local';

interface MarketsState {
  bySym: Record<string, LiveMarket>;
  order: string[];
  source: FeedSource;
  /** Increments on every price update (drives chart/ticket refresh). */
  tick: number;
  /** Time of the last successful poll (ms), or null before the first one. */
  lastOkAt: number | null;
  /** Consecutive failed polls. */
  failures: number;
  /** Mainnet only: the feed failed repeatedly or has not succeeded for over a minute. Every price is then stale. */
  feedStale: boolean;
}

/** Mainnet: a price is stale when no poll has succeeded for this long (the API's own freshness window). */
export const PRICE_MAX_AGE_MS = 60_000;
/** Mainnet: this many failed polls in a row mark the whole feed stale. */
export const STALE_AFTER_FAILURES = 2;

type FeedHealth = Pick<MarketsState, 'lastOkAt' | 'failures'>;

/** Whether the feed as a whole is stale (rule used on mainnet). */
export function feedIsStale(f: FeedHealth, now: number): boolean {
  if (f.failures >= STALE_AFTER_FAILURES) return true;
  return f.lastOkAt !== null && now - f.lastOkAt > PRICE_MAX_AGE_MS;
}

/**
 * The one rule for a price money logic may use, or null when there is none. Pure, so tests can
 * check both networks. No live data (API source null) means no price on any network; on mainnet a
 * market the API marks stale, a stale feed, or no successful poll in the last minute also mean none.
 */
export function tradablePrice(m: LiveMarket | undefined, feed: FeedHealth & { feedStale: boolean }, now: number, mainnet: boolean): Wad | null {
  if (!m || m.noData || m.price <= 0n) return null;
  if (!mainnet) return m.price;
  if (m.stale || feed.feedStale || feedIsStale(feed, now)) return null;
  if (feed.lastOkAt === null) return null;
  return m.price;
}

/** Display state of a market's price: none (dash), stale (last price, marked) or live. */
export type PriceState = 'none' | 'stale' | 'live';
export function priceState(m: LiveMarket | undefined, feed: FeedHealth & { feedStale: boolean }, now: number, mainnet: boolean): PriceState {
  if (!m || m.noData) return 'none';
  return tradablePrice(m, feed, now, mainnet) === null ? 'stale' : 'live';
}

const w = (s: string | undefined, fallback: Wad): Wad => (s ? parseWad(s) ?? fallback : fallback);
const pctChange = (price: Wad, open: Wad) => (open > 0n ? (toNumber(price - open) / toNumber(open)) * 100 : 0);

function seedMarkets(): Record<string, LiveMarket> {
  const out: Record<string, LiveMarket> = {};
  for (const m of MARKETS) {
    const price = parseWad(m.seedPrice)!;
    const n = toNumber(price);
    out[m.symbol] = {
      sym: m.symbol,
      name: m.name,
      status: m.status,
      token: m.token?.address ?? null,
      price,
      priceNum: n,
      mark: price,
      open: price,
      chg: 0,
      funding: Number(m.fundingPerHour),
      oi: Number(m.openInterest),
      maxLev: 5,
      hist: Array.from({ length: 60 }, () => n),
      dir: 1,
      stale: true,
      priceSource: 'demo',
      noData: IS_MAINNET,
    };
  }
  return out;
}

export const useMarkets = create<MarketsState>(() => ({
  bySym: seedMarkets(),
  order: MARKETS.map((m) => m.symbol),
  source: 'seed',
  tick: 0,
  lastOkAt: null,
  failures: 0,
  feedStale: false,
}));

/** The tradable price for `sym` now, or null (see tradablePrice). Use this, never `.price`, for money. */
export function livePrice(sym: string, now = Date.now()): Wad | null {
  const s = useMarkets.getState();
  return tradablePrice(s.bySym[sym], s, now, IS_MAINNET);
}

/** React: the tradable price for `sym`, re-evaluated on every price update and feed health change. */
export function useLivePrice(sym: string): Wad | null {
  const m = useMarkets((s) => s.bySym[sym]);
  const lastOkAt = useMarkets((s) => s.lastOkAt);
  const failures = useMarkets((s) => s.failures);
  const feedStale = useMarkets((s) => s.feedStale);
  return tradablePrice(m, { lastOkAt, failures, feedStale }, Date.now(), IS_MAINNET);
}

/** React: re-render on every price update and every feed health change (for totals built from livePrice). */
export function usePriceTick(): void {
  useMarkets((s) => s.tick);
  useMarkets((s) => s.failures);
  useMarkets((s) => s.feedStale);
}

export function usePriceState(sym: string): PriceState {
  const m = useMarkets((s) => s.bySym[sym]);
  const lastOkAt = useMarkets((s) => s.lastOkAt);
  const failures = useMarkets((s) => s.failures);
  const feedStale = useMarkets((s) => s.feedStale);
  return priceState(m, { lastOkAt, failures, feedStale }, Date.now(), IS_MAINNET);
}

export const mk = (sym: string): LiveMarket => {
  const s = useMarkets.getState().bySym;
  return s[sym] ?? s[MARKETS[0]!.symbol]!;
};

export function useMarket(sym: string): LiveMarket {
  return useMarkets((s) => s.bySym[sym] ?? s.bySym[MARKETS[0]!.symbol]!);
}

/**
 * Price in USDG for any token, or null when there is none: USDG = 1; ETH = the prototype's demo
 * constant on testnet and unpriced on mainnet (no ETH feed); stock tokens = livePrice.
 */
export const ETH_DEMO_PRICE = fromNumber(3420);
export function tokPx(t: string, now = Date.now()): Wad | null {
  if (t === 'USDG') return 10n ** 18n;
  if (t === 'ETH') return IS_MAINNET ? null : ETH_DEMO_PRICE;
  return livePrice(t, now);
}

function applyApi(list: MarketDTO[], now: number) {
  useMarkets.setState((s) => {
    const bySym = { ...s.bySym };
    for (const d of list) {
      const prev = bySym[d.symbol];
      if (!prev) continue;
      const noData = d.source === null || (IS_MAINNET && !d.source);
      const meta = { name: d.name, status: d.status, token: d.token, funding: Number(d.fundingPerHour), oi: Number(d.openInterest), maxLev: d.maxLeverage, stale: !!d.stale };
      if (noData) {
        // With no live data the API sends the config seed price: never store it (or anything derived
        // from it) as this market's price. The last real values stay, flagged; the UI shows a dash.
        bySym[d.symbol] = { ...prev, ...meta, noData: true };
        continue;
      }
      const price = w(d.price, prev.price);
      const open = w(d.open24h, prev.open);
      const spark = d.spark?.length ? d.spark.map(Number) : prev.hist;
      bySym[d.symbol] = {
        ...prev,
        ...meta,
        price,
        priceNum: toNumber(price),
        mark: w(d.mark, price),
        open,
        chg: d.change24h !== undefined ? Number(d.change24h) : pctChange(price, open),
        hist: spark,
        dir: price === prev.price ? prev.dir : price > prev.price ? 1 : -1,
        priceSource: d.source ?? prev.priceSource,
        noData: false,
      };
    }
    return { bySym, source: 'api', tick: s.tick + 1, lastOkAt: now, failures: 0, feedStale: false };
  });
}

/* ---------- local demo simulator (prototype tick) ---------- */
const gauss = () => {
  let u = 0;
  let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const VOL: Record<string, number> = Object.fromEntries(MARKETS.map((m) => [m.symbol, m.vol]));
const toW = (n: number) => fromNumber(Number(n.toFixed(6)));
let localTicks = 0;

function startLocal() {
  useMarkets.setState((s) => {
    const bySym = { ...s.bySym };
    for (const sym of s.order) {
      const m = bySym[sym]!;
      const vol = VOL[sym] ?? 0.0015;
      const p0 = m.priceNum;
      const open = toW(p0 * (1 + rnd(-0.034, 0.03)));
      const hist: number[] = [];
      let p = p0;
      for (let i = 0; i < 60; i++) {
        hist.unshift(p);
        p = p * (1 - gauss() * vol);
      }
      // Testnet demo only (never mainnet): the local walk is this market's simulated price.
      bySym[sym] = { ...m, open, chg: pctChange(m.price, open), hist, stale: false, noData: false };
    }
    return { bySym, source: 'local' };
  });
}

function localTick() {
  localTicks++;
  useMarkets.setState((s) => {
    const bySym = { ...s.bySym };
    for (const sym of s.order) {
      const m = bySym[sym]!;
      const vol = VOL[sym] ?? 0.0015;
      const n = Math.max(1, m.priceNum * (1 + gauss() * vol));
      const price = toW(n);
      const hist = m.hist.slice();
      if (localTicks % 3 === 0) {
        hist.push(n);
        if (hist.length > 60) hist.shift();
      } else hist[hist.length - 1] = n;
      bySym[sym] = { ...m, price, priceNum: n, mark: toW(n * 1.0004), chg: pctChange(price, m.open), hist, dir: n >= m.priceNum ? 1 : -1 };
    }
    return { bySym, tick: s.tick + 1 };
  });
}

/** Starts polling; returns a stop function. Mounted once in Providers. */
export function startMarketFeed(): () => void {
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let localTimer: ReturnType<typeof setInterval> | undefined;
  let ctrl: AbortController | undefined;

  const goLocal = () => {
    // Mainnet never shows simulated prices: markets keep their last real value or show a dash (audit web M4).
    if (localTimer || !ENV.demoMode || IS_MAINNET) return;
    startLocal();
    localTimer = setInterval(localTick, 1600);
  };
  const stopLocal = () => {
    if (localTimer) clearInterval(localTimer);
    localTimer = undefined;
  };

  /** Mainnet: flag the whole feed stale after repeated failures or a minute without a good poll. */
  const checkHealth = () => {
    if (!IS_MAINNET) return;
    const s = useMarkets.getState();
    const stale = feedIsStale(s, Date.now());
    if (stale !== s.feedStale) useMarkets.setState({ feedStale: stale });
  };

  const poll = async () => {
    if (stopped) return;
    ctrl = new AbortController();
    const t = setTimeout(() => ctrl?.abort(), 4000);
    try {
      const list = await api.markets(ctrl.signal);
      if (!Array.isArray(list)) throw new Error('Bad markets payload');
      failures = 0;
      stopLocal();
      applyApi(list, Date.now());
    } catch {
      failures++;
      useMarkets.setState({ failures });
      checkHealth();
      if (failures >= 2) goLocal();
    } finally {
      clearTimeout(t);
    }
    if (!stopped) timer = setTimeout(poll, localTimer ? 10_000 : 2000);
  };
  // Catches a stalled poll loop too (e.g. timers throttled in a background tab).
  const health = setInterval(checkHealth, 5000);

  const onVisible = () => {
    if (document.visibilityState === 'visible' && !stopped) {
      if (timer) clearTimeout(timer);
      void poll();
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  void poll();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearInterval(health);
    stopLocal();
    ctrl?.abort();
    document.removeEventListener('visibilitychange', onVisible);
  };
}
