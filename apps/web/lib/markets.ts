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
 * What counts as a live price from the API is readApiMarket (audit web F2; final audit W-01, W-03):
 * the API's own stale/staleReason/marketOpen flags, read fail-safe, plus this client's response
 * freshness (time since the last successful poll), never the age of `updatedAt`. One poll runs at a
 * time and only the newest answer is applied (F6); a market missing from an answer has no data (W-02).
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
  /** Price source reported by the API: 'demo' (simulated), 'robinhood', 'chainlink' or 'uniswap'. */
  priceSource: string;
  /** No live price: the API reports none (source null, no usable price, or on mainnet a source that is not real) or nothing has arrived yet. Displayed as a dash. */
  noData: boolean;
  /** The API flags this market's protocol metrics (OI, funding) as demo data. */
  demo: boolean;
  /** The stock market is closed (API staleReason marketClosed): the last price is shown, marked closed, never tradable on mainnet. */
  closed: boolean;
  /**
   * Mainnet: the venue whose perp supplies mark, funding and open interest (PERP_VENUES), or null. These are a labelled
   * market reference while Velum's own perps are not live there.
   */
  ref: PerpVenueId | null;
}

/** Perps venues the API may name as the source of mark, funding and open interest, with their display names. */
export const PERP_VENUES = { hyperliquid: 'Hyperliquid', lighter: 'Lighter' } as const;
export type PerpVenueId = keyof typeof PERP_VENUES;

/** The venue of an API `perpsRef`, or null for anything else (absent, malformed, unknown venue). */
export function apiPerpVenue(v: unknown): PerpVenueId | null {
  const venue = v && typeof v === 'object' ? (v as { venue?: unknown }).venue : null;
  return typeof venue === 'string' && Object.prototype.hasOwnProperty.call(PERP_VENUES, venue) ? (venue as PerpVenueId) : null;
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

/**
 * Mainnet: every price is stale when no poll has succeeded for this long (this client's response
 * freshness, final audit W-03). Polls run every 2 s and STALE_AFTER_FAILURES catches a failing API
 * within seconds; this catches a stalled poll loop (a throttled background tab, a hung request).
 */
export const PRICE_MAX_AGE_MS = 60_000;
/** A quote time more than this far ahead of the server's clock is invalid (the API's own rule, docs/03-api.md). */
export const MAX_FUTURE_MS = 30_000;
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

/**
 * A price as the API validates it (docs/03-api.md: decimal strings, prices in (0, 1e9)): a plain
 * decimal string with at most 9 integer and 18 fraction places, no sign, exponent, spaces, separators
 * or trailing text (final audit W-01: "391.65abc", "1e30", "250,50" and "12.5.7" were read as prices).
 */
const PRICE_RE = /^\d{1,9}(\.\d{1,18})?$/;
/** Exclusive upper bound of an API price: 1e9 USDG, as a wad. */
export const PRICE_MAX: Wad = 10n ** 27n;

/** A price from the API, or null for anything else (not a string, malformed, zero, out of bounds). */
export const apiPrice = (s: unknown): Wad | null => {
  if (typeof s !== 'string' || !PRICE_RE.test(s)) return null;
  const v = parseWad(s);
  return v !== null && v > 0n && v < PRICE_MAX ? v : null;
};
const pctChange = (price: Wad, open: Wad) => (open > 0n ? (toNumber(price - open) / toNumber(open)) * 100 : 0);

/** The price sources mainnet accepts as real data (audit web F2); anything else there is no data. */
export const REAL_SOURCES: readonly string[] = ['robinhood', 'chainlink', 'uniswap'];

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
 * usable price (source null, a malformed price, or on mainnet any source but robinhood/chainlink),
 * `stale` when the API says so or leaves it out.
 *
 * On mainnet a price is live only when the API says so in full, read fail-safe (final audit W-03):
 * `stale` exactly false, `staleReason` exactly null, `marketOpen` exactly true, and a readable
 * `updatedAt` no more than MAX_FUTURE_MS ahead of the server's clock (`serverNow`, the response's
 * Date header; without it the check cannot be made, so nothing is live). `updatedAt` is when the
 * quote last changed, so its age is not a staleness signal here: a quiet quote stays fresh until the
 * API marks it `quoteFrozen` (15 minutes), and `outdated` covers workers that stopped confirming it.
 * `closed` when the API reports the stock market closed (staleReason marketClosed, or marketOpen
 * false): the price is the last quote, hours old on weekends, so it is always stale (never live or
 * tradable) but shown with a closed note, not as an error.
 */
export function readApiMarket(d: MarketDTO, serverNow: number | null, mainnet: boolean): { price: Wad | null; noData: boolean; stale: boolean; closed: boolean } {
  const price = apiPrice(d.price);
  const sourceOk = mainnet ? typeof d.source === 'string' && REAL_SOURCES.includes(d.source) : d.source !== null;
  const noData = !sourceOk || price === null;
  const closed = d.staleReason === 'marketClosed' || d.marketOpen === false;
  let stale = d.stale !== false || closed;
  if (mainnet && !stale) {
    const t = apiTime(d.updatedAt);
    stale = d.staleReason !== null || d.marketOpen !== true || t === null || serverNow === null || t > serverNow + MAX_FUTURE_MS;
  }
  return { price, noData, stale, closed };
}

const STATUSES: readonly string[] = ['live', 'coming_soon', 'close_only'] satisfies MarketStatus[];
/** A company name as the API should send it: letters, numbers and plain punctuation, at most 40 characters. */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,&'()-]{0,39}$/u;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** 1×, a position without leverage: the slider's low end (MIN_LEVERAGE in lib/calc, which imports this module). */
const LEV_FLOOR = 1;

/** A market's max leverage from the API: a number, floored to the slider step, within 1..PROTOCOL max; otherwise `fallback`. */
export function apiMaxLeverage(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const stepped = Math.floor(v / PROTOCOL.leverageStep) * PROTOCOL.leverageStep;
  return Math.min(PROTOCOL.maxLeverage, Math.max(LEV_FLOOR, stepped));
}

type Meta = Pick<LiveMarket, 'name' | 'status' | 'token' | 'maxLev'>;

/**
 * The API's descriptive fields for one market, validated (final audit W-15): anything malformed keeps
 * the previous value (the config's, or the last valid one), never what the API sent.
 */
export function apiMeta(d: MarketDTO, prev: Meta): Meta {
  return {
    name: typeof d.name === 'string' && NAME_RE.test(d.name) ? d.name : prev.name,
    status: STATUSES.includes(d.status) ? d.status : prev.status,
    token: d.token === null ? null : typeof d.token === 'string' && ADDRESS_RE.test(d.token) ? d.token : prev.token,
    maxLev: apiMaxLeverage(d.maxLeverage, prev.maxLev),
  };
}

/** Last-hour sparkline from the API (display only): at most 60 valid prices, oldest first; malformed points are dropped. */
export const apiSpark = (v: unknown): number[] =>
  Array.isArray(v)
    ? v
        .slice(-60)
        .map(apiPrice)
        .filter((p): p is Wad => p !== null)
        .map(toNumber)
    : [];

/** 24h change in percent from the API (display only), or NaN when malformed. */
const apiChange = (v: unknown): number => (typeof v === 'string' && /^-?\d{1,6}(\.\d{1,18})?$/.test(v) ? Number(v) : Number.NaN);

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
      ref: null,
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

function applyApi(list: unknown[], now: number, serverNow: number | null) {
  useMarkets.setState((s) => {
    const bySym = { ...s.bySym };
    const seen = new Set<string>();
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const d = item as MarketDTO;
      // Own keys only: a symbol such as "__proto__" must not reach the prototype.
      const prev = typeof d.symbol === 'string' && Object.prototype.hasOwnProperty.call(bySym, d.symbol) ? bySym[d.symbol] : undefined;
      // Unknown markets and repeats of one already read in this answer are ignored.
      if (!prev || seen.has(d.symbol)) continue;
      seen.add(d.symbol);
      const r = readApiMarket(d, serverNow, IS_MAINNET);
      const meta = {
        ...apiMeta(d, prev),
        funding: apiMetric(d.fundingPerHour),
        oi: apiMetric(d.openInterest),
        ref: apiPerpVenue(d.perpsRef),
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
      const chg = apiChange(d.change24h);
      const spark = apiSpark(d.spark);
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
    // A market this answer leaves out has no data now (final audit W-02): its last price must not stay
    // live because later answers stopped mentioning it (version skew, an API bug).
    for (const sym of s.order) if (!seen.has(sym)) bySym[sym] = { ...bySym[sym]!, noData: true, stale: true };
    return { bySym, source: 'api', tick: s.tick + 1, lastOkAt: now, failures: 0, feedStale: false };
  });
}

/**
 * Where the prices on screen come from (for copy that names the source, audit web F2): a real
 * source only when some market has a usable price from it. On mainnet the words follow the feed
 * (final audit W-07): 'none' once the API failed repeatedly or the feed went stale (so "Loading" does
 * not stay forever while the API is down), and 'closed' when every market priced from a real source
 * is closed (the prices shown are the last quotes).
 */
export function priceOrigin(s: Pick<MarketsState, 'bySym' | 'source'> & Partial<Pick<MarketsState, 'failures' | 'feedStale'>>, mainnet = IS_MAINNET): PriceOrigin {
  const down = mainnet && ((s.failures ?? 0) >= STALE_AFTER_FAILURES || s.feedStale === true);
  if (s.source === 'seed') return mainnet ? (down ? 'none' : 'loading') : 'demo';
  if (s.source === 'local') return 'demo';
  if (down) return 'none';
  const live = Object.values(s.bySym).filter((m) => !m.noData);
  const real = live.filter((m) => REAL_SOURCES.includes(m.priceSource));
  if (mainnet && real.length > 0 && real.every((m) => m.closed)) return 'closed';
  if (live.some((m) => m.priceSource === 'uniswap')) return 'uniswap';
  if (live.some((m) => m.priceSource === 'robinhood')) return 'robinhood';
  if (live.some((m) => m.priceSource === 'chainlink')) return 'chainlink';
  return live.length ? 'demo' : 'none';
}

export function usePriceOrigin(): PriceOrigin {
  const bySym = useMarkets((s) => s.bySym);
  const source = useMarkets((s) => s.source);
  const failures = useMarkets((s) => s.failures);
  const feedStale = useMarkets((s) => s.feedStale);
  return priceOrigin({ bySym, source, failures, feedStale });
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
        // serverNow is the response's Date header; without it no mainnet price is live (readApiMarket).
        applyApi(list, Date.now(), serverNow);
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
