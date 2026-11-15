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
 * What counts as a live price from the API is readApiMarket (audit web F2); one poll runs at a time
 * and only the newest answer is applied (F6).
 */
import { IS_MAINNET, MARKETS, PROTOCOL, type MarketStatus } from '@velum/config';
import { fromNumber, parseWad, toNumber, type Wad } from '@velum/math';
import { create } from 'zustand';
import { api, type MarketDTO } from './api';
import type { PriceOrigin } from './copy';
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
  /** Funding per hour in percent, e.g. 0.0042; null when the API has none (mainnet). */
  funding: number | null;
  /** Open interest in USDG; null when the API has none (mainnet). */
  oi: number | null;
  maxLev: number;
  /** Last-hour sparkline, oldest first (display only). */
  hist: number[];
  dir: 1 | -1;
  stale: boolean;
  /** Price source reported by the API: 'demo' (simulated), 'robinhood' or 'chainlink'. */
  priceSource: string;
  /** No live price: the API reports none (source null, no usable price, or on mainnet a source that is not real) or nothing has arrived yet. Displayed as a dash. */
  noData: boolean;
  /** The API flags this market's protocol metrics (OI, funding) as demo data. */
  demo: boolean;
  /** The stock market is closed (API staleReason marketClosed): the last price is shown, marked closed, never tradable on mainnet. */
  closed: boolean;
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

/** A positive decimal price from the API, or null for anything else (empty, malformed, zero, negative). */
export const apiPrice = (s: unknown): Wad | null => {
  if (typeof s !== 'string' || !s.trim()) return null;
  const v = parseWad(s.trim());
  return v !== null && v > 0n ? v : null;
};
const pctChange = (price: Wad, open: Wad) => (open > 0n ? (toNumber(price - open) / toNumber(open)) * 100 : 0);

/** The price sources mainnet accepts as real data (audit web F2); anything else there is no data. */
export const REAL_SOURCES: readonly string[] = ['robinhood', 'chainlink'];

/** `updatedAt` from the API (ms since epoch, or an ISO string), or null when missing or unreadable. */
export function apiTime(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = /^\d+$/.test(v.trim()) ? Number(v.trim()) : Date.parse(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/** A protocol metric from the API (funding, open interest) as a number, or null when absent or unreadable. */
export const apiMetric = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * How one API market reads (pure, so tests can check both networks): `noData` when there is no
 * usable price (source null, an unparsable price, or on mainnet any source but robinhood/chainlink),
 * `stale` when the API says so or leaves it out, or, on mainnet, when `updatedAt` is missing or older
 * than PRICE_MAX_AGE_MS at the server's time (`serverNow`, from the response's Date header).
 * `closed` when the API reports the stock market closed (staleReason marketClosed, or marketOpen
 * false): the price is the last quote, hours old on weekends, so it is always stale (never live or
 * tradable) but shown with a closed note, not as an error.
 */
export function readApiMarket(d: MarketDTO, serverNow: number, mainnet: boolean): { price: Wad | null; noData: boolean; stale: boolean; closed: boolean } {
  const price = apiPrice(d.price);
  const sourceOk = mainnet ? typeof d.source === 'string' && REAL_SOURCES.includes(d.source) : d.source !== null;
  const noData = !sourceOk || price === null;
  const closed = d.staleReason === 'marketClosed' || d.marketOpen === false;
  let stale = d.stale !== false || closed;
  if (mainnet && !stale) {
    const t = apiTime(d.updatedAt);
    stale = t === null || serverNow - t > PRICE_MAX_AGE_MS;
  }
  return { price, noData, stale, closed };
}

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
      maxLev: PROTOCOL.maxLeverage,
      hist: Array.from({ length: 60 }, () => n),
      dir: 1,
      stale: true,
      priceSource: 'demo',
      noData: IS_MAINNET,
      demo: true,
      closed: false,
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

function applyApi(list: MarketDTO[], now: number, serverNow: number) {
  useMarkets.setState((s) => {
    const bySym = { ...s.bySym };
    for (const d of list) {
      const prev = bySym[d.symbol];
      if (!prev) continue;
      const r = readApiMarket(d, serverNow, IS_MAINNET);
      const meta = {
        name: d.name,
        status: d.status,
        token: d.token,
        funding: apiMetric(d.fundingPerHour),
        oi: apiMetric(d.openInterest),
        maxLev: Math.min(Number(d.maxLeverage) || PROTOCOL.maxLeverage, PROTOCOL.maxLeverage),
        stale: r.stale,
        demo: d.demo === true,
        closed: r.closed,
      };
      if (r.noData || r.price === null) {
        // No usable price: never store what the API sent (it may be the config seed or garbage), nor
        // fall back to the previous or seed price. The last real values stay, flagged; the UI shows a dash.
        bySym[d.symbol] = { ...prev, ...meta, noData: true };
        continue;
      }
      const price = r.price;
      const open = apiPrice(d.open24h) ?? price;
      const chg = Number(d.change24h);
      const spark = Array.isArray(d.spark) && d.spark.length ? d.spark.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
      bySym[d.symbol] = {
        ...prev,
        ...meta,
        price,
        priceNum: toNumber(price),
        mark: apiPrice(d.mark) ?? price,
        open,
        chg: Number.isFinite(chg) ? chg : pctChange(price, open),
        hist: spark.length > 1 ? spark : prev.hist,
        dir: price === prev.price ? prev.dir : price > prev.price ? 1 : -1,
        priceSource: d.source ?? prev.priceSource,
        noData: false,
      };
    }
    return { bySym, source: 'api', tick: s.tick + 1, lastOkAt: now, failures: 0, feedStale: false };
  });
}

/**
 * Where the prices on screen come from (for copy that names the source, audit web F2): a real
 * source only when some market has a usable price from it.
 */
export function priceOrigin(s: Pick<MarketsState, 'bySym' | 'source'>, mainnet = IS_MAINNET): PriceOrigin {
  if (s.source === 'seed') return mainnet ? 'loading' : 'demo';
  if (s.source === 'local') return 'demo';
  const live = Object.values(s.bySym).filter((m) => !m.noData);
  if (live.some((m) => m.priceSource === 'robinhood')) return 'robinhood';
  if (live.some((m) => m.priceSource === 'chainlink')) return 'chainlink';
  return live.length ? 'demo' : 'none';
}

export function usePriceOrigin(): PriceOrigin {
  const bySym = useMarkets((s) => s.bySym);
  const source = useMarkets((s) => s.source);
  return priceOrigin({ bySym, source });
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

  // One poll at a time (audit web F6): a poll that is still running when the tab becomes visible
  // again is not doubled, and only the newest request's answer is applied.
  let inFlight = false;
  let seq = 0;
  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = stopped ? undefined : setTimeout(() => void poll(), ms);
  };
  const poll = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    const my = ++seq;
    if (timer) clearTimeout(timer);
    timer = undefined;
    ctrl = new AbortController();
    const t = setTimeout(() => ctrl?.abort(), 4000);
    try {
      const { list, serverNow } = await api.marketsAt(ctrl.signal);
      if (!Array.isArray(list)) throw new Error('Bad markets payload');
      if (my === seq && !stopped) {
        failures = 0;
        stopLocal();
        const now = Date.now();
        applyApi(list, now, serverNow ?? now);
      }
    } catch {
      if (my === seq && !stopped) {
        failures++;
        useMarkets.setState({ failures });
        checkHealth();
        if (failures >= 2) goLocal();
      }
    } finally {
      clearTimeout(t);
      inFlight = false;
    }
    schedule(localTimer ? 10_000 : 2000);
  };
  // Catches a stalled poll loop too (e.g. timers throttled in a background tab).
  const health = setInterval(checkHealth, 5000);

  const onVisible = () => {
    // Poll now, unless a poll is already running (it schedules the next one itself).
    if (document.visibilityState === 'visible' && !stopped && !inFlight) void poll();
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
