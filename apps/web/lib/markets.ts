'use client';
/**
 * Live market data. Source of truth is the API (/v1/markets, polled every 2 s).
 * Before the first response we render the config seed (deterministic, so SSR matches).
 * In demo mode only, if the API is unreachable the browser runs the prototype's random walk
 * so the demo keeps working; it switches back as soon as the API answers.
 */
import { MARKETS, type MarketStatus } from '@velum/config';
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
  /** Price source reported by the API: 'demo' (simulated) or 'chainlink'. */
  priceSource: string;
}

export type FeedSource = 'seed' | 'api' | 'local';

interface MarketsState {
  bySym: Record<string, LiveMarket>;
  order: string[];
  source: FeedSource;
  /** Increments on every price update (drives chart/ticket refresh). */
  tick: number;
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
    };
  }
  return out;
}

export const useMarkets = create<MarketsState>(() => ({
  bySym: seedMarkets(),
  order: MARKETS.map((m) => m.symbol),
  source: 'seed',
  tick: 0,
}));

export const mk = (sym: string): LiveMarket => {
  const s = useMarkets.getState().bySym;
  return s[sym] ?? s[MARKETS[0]!.symbol]!;
};

export function useMarket(sym: string): LiveMarket {
  return useMarkets((s) => s.bySym[sym] ?? s.bySym[MARKETS[0]!.symbol]!);
}

/** Price in USDG for any token (USDG = 1, ETH = demo constant from the prototype). */
export const ETH_DEMO_PRICE = fromNumber(3420);
export function tokPx(t: string): Wad {
  if (t === 'USDG') return 10n ** 18n;
  if (t === 'ETH') return ETH_DEMO_PRICE;
  return mk(t).price;
}

function applyApi(list: MarketDTO[]) {
  useMarkets.setState((s) => {
    const bySym = { ...s.bySym };
    for (const d of list) {
      const prev = bySym[d.symbol];
      if (!prev) continue;
      const price = w(d.price, prev.price);
      const open = w(d.open24h, prev.open);
      const spark = d.spark?.length ? d.spark.map(Number) : prev.hist;
      bySym[d.symbol] = {
        ...prev,
        name: d.name,
        status: d.status,
        token: d.token,
        price,
        priceNum: toNumber(price),
        mark: w(d.mark, price),
        open,
        chg: d.change24h !== undefined ? Number(d.change24h) : pctChange(price, open),
        funding: Number(d.fundingPerHour),
        oi: Number(d.openInterest),
        maxLev: d.maxLeverage,
        hist: spark,
        dir: price === prev.price ? prev.dir : price > prev.price ? 1 : -1,
        stale: !!d.stale,
        priceSource: d.source ?? prev.priceSource,
      };
    }
    return { bySym, source: 'api', tick: s.tick + 1 };
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
      bySym[sym] = { ...m, open, chg: pctChange(m.price, open), hist, stale: false };
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
    if (localTimer || !ENV.demoMode) return;
    startLocal();
    localTimer = setInterval(localTick, 1600);
  };
  const stopLocal = () => {
    if (localTimer) clearInterval(localTimer);
    localTimer = undefined;
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
      applyApi(list);
    } catch {
      failures++;
      if (failures >= 2) goLocal();
    } finally {
      clearTimeout(t);
    }
    if (!stopped) timer = setTimeout(poll, localTimer ? 10_000 : 2000);
  };

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
    stopLocal();
    ctrl?.abort();
    document.removeEventListener('visibilitychange', onVisible);
  };
}
