'use client';
/** Canvas candlestick chart, ported from the prototype's drawChart. */
import { IS_MAINNET, MARKETS, TIMEFRAME_MS, type Timeframe } from '@velum/config';
import { toNumber } from '@velum/math';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { chartCandles, chartLayout, readoutTime, type ChartCandle } from '@/lib/candles';
import { ENV } from '@/lib/env';
import { CLOSED, SESSION } from '@/lib/copy';
import { fmt } from '@/lib/format';
import { mk, priceState, useMarkets } from '@/lib/markets';
import { useApp } from '@/lib/store';

type C = ChartCandle;

const COL = { up: '#3FCF8E', down: '#F25C61', faint: '#5E626A', text: '#F4F5F6' };
const TFV: Record<Timeframe, number> = { '15m': 1, '1h': 1.9, '4h': 3.6, '1D': 7 };
const VOL: Record<string, number> = Object.fromEntries(MARKETS.map((m) => [m.symbol, m.vol]));
const N_CANDLES = 110;

const gauss = () => {
  let u = 0;
  let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Local demo candles (used only if the API is unreachable in demo mode). */
function genCandles(sym: string, tf: Timeframe): C[] {
  const price = mk(sym).priceNum;
  const v = (VOL[sym] ?? 0.0015) * TFV[tf] * 2.3;
  const ms = TIMEFRAME_MS[tf];
  const now = Math.floor(Date.now() / ms) * ms;
  let p = price;
  let drift = 0;
  const a: C[] = [];
  for (let i = 0; i < N_CANDLES; i++) {
    if (i % 28 === 0) drift = rnd(-0.45, 0.45) * v;
    const c = p;
    const o = c * (1 - gauss() * v - drift);
    const h = Math.max(o, c) * (1 + Math.abs(gauss()) * v * 0.55);
    const l = Math.min(o, c) * (1 - Math.abs(gauss()) * v * 0.55);
    a.unshift({ t: now - i * ms, o, h, l, c });
    p = o;
  }
  return a;
}

function rr(x: CanvasRenderingContext2D, a: number, b: number, w: number, h: number, r: number) {
  x.beginPath();
  x.moveTo(a + r, b);
  x.arcTo(a + w, b, a + w, b + h, r);
  x.arcTo(a + w, b + h, a, b + h, r);
  x.arcTo(a, b + h, a, b, r);
  x.arcTo(a, b, a + w, b, r);
  x.closePath();
}

export function Chart({ sym }: { sym: string }) {
  const tf = useApp((s) => s.tf);
  const veiled = useApp((s) => s.veiled);
  const positions = useApp((s) => s.ledger.positions);
  const source = useMarkets((s) => s.source);
  const tick = useMarkets((s) => s.tick);
  // Redraw when the feed turns stale (no tick then), so the price tag shows it.
  const feedStale = useMarkets((s) => s.feedStale);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const candles = useRef<C[]>([]);
  /** Session boundaries (separators before these indexes) of the drawn candles. */
  const breaks = useRef<number[]>([]);
  const [hasDex, setHasDex] = useState(false);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const localTicks = useRef(0);
  const [ohlc, setOhlc] = useState<{ d: string; c: C } | null>(null);

  const q = useQuery({
    queryKey: ['candles', sym, tf],
    queryFn: ({ signal }) => api.candles(sym, tf, N_CANDLES, signal),
    refetchInterval: 6000,
    retry: 1,
    enabled: source !== 'local',
  });
  // Only valid candles are drawn (final audit W-11): malformed ones are dropped.
  const valid = useMemo(() => chartCandles(q.data), [q.data]);
  // The API answered with no candles yet (a new market): not an error.
  const apiEmpty = q.isSuccess && Array.isArray(q.data) && q.data.length === 0;
  // Simulated candles are a testnet demo fallback only. Mainnet never draws made-up history: without
  // valid candles from the API it says the chart is unavailable (audit web F1, W-11).
  const useLocal = ENV.demoMode && !IS_MAINNET && (source === 'local' || (q.isError && !valid.length));
  const unavailable = !useLocal && !valid.length && (q.isError || (q.isSuccess && !apiEmpty));

  useEffect(() => {
    if (useLocal) {
      candles.current = genCandles(sym, tf);
      breaks.current = [];
      localTicks.current = 0;
      setHasDex(false);
    } else {
      // Session layout: closed time that only repeats the last price is compressed, sessions are separated.
      const lay = chartLayout(valid, tf);
      candles.current = lay.list.map((k) => ({ ...k }));
      breaks.current = lay.breaks;
      setHasDex(lay.hasDex);
    }
  }, [valid, useLocal, sym, tf]);

  const draw = useCallback(() => {
    const cv = cvRef.current;
    const list = candles.current;
    if (!cv) return;
    if (!list.length) {
      // No candles (loading, or unavailable): never leave the previous market's chart on screen.
      cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
      setOhlc(null);
      return;
    }
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const x = cv.getContext('2d');
    if (!x) return;
    const st = useApp.getState();
    const font = getComputedStyle(document.body).fontFamily || 'Inter, system-ui, sans-serif';
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    const AX = 70;
    const PT = 12;
    const PB = 12;
    const cw = W - AX;
    const n = list.length;
    let hi = -Infinity;
    let lo = Infinity;
    for (const c of list) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
    }
    // While closed the tag shows the last official quote (the last candle may be an on-chain DEX one): keep it in range.
    const lm = mk(sym);
    const tagPrice = lm.closed && !lm.noData ? lm.priceNum : list[n - 1]!.c;
    hi = Math.max(hi, tagPrice);
    lo = Math.min(lo, tagPrice);
    const pad = (hi - lo) * 0.08 || 1;
    hi += pad;
    lo -= pad;
    const Y = (v: number) => PT + ((hi - v) / (hi - lo)) * (H - PT - PB);
    const F = (wt: number) => `${wt} 11.5px ${font}`;
    x.font = F(500);
    x.textBaseline = 'middle';
    x.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const v = lo + ((hi - lo) * i) / 5;
      const yy = Math.round(Y(v)) + 0.5;
      x.strokeStyle = 'rgba(255,255,255,.045)';
      x.beginPath();
      x.moveTo(0, yy);
      x.lineTo(cw, yy);
      x.stroke();
      x.fillStyle = COL.faint;
      x.fillText(fmt(v), cw + 12, yy);
    }
    for (let i = 1; i < 6; i++) {
      const xx = Math.round((cw * i) / 6) + 0.5;
      x.strokeStyle = 'rgba(255,255,255,.03)';
      x.beginPath();
      x.moveTo(xx, PT);
      x.lineTo(xx, H - PB);
      x.stroke();
    }
    const stp = cw / n;
    const bw = Math.max(1.6, stp * 0.58);
    // Session separators: a subtle dashed line where a session starts (closed time between them is compressed).
    x.save();
    x.setLineDash([2, 4]);
    x.strokeStyle = 'rgba(255,255,255,.09)';
    for (const i of breaks.current) {
      if (i <= 0 || i >= n) continue;
      const xx = Math.round(i * stp) + 0.5;
      x.beginPath();
      x.moveTo(xx, PT);
      x.lineTo(xx, H - PB);
      x.stroke();
    }
    x.restore();
    list.forEach((c, i) => {
      const cx = i * stp + stp / 2;
      const col = c.c >= c.o ? COL.up : COL.down;
      const dex = c.src === 'dex';
      // On-chain DEX candles of closed periods (display only): hollow and dimmed, never mistaken for official quotes.
      if (dex) x.globalAlpha = 0.6;
      x.strokeStyle = col;
      x.fillStyle = col;
      x.beginPath();
      x.moveTo(Math.round(cx) + 0.5, Y(c.h));
      x.lineTo(Math.round(cx) + 0.5, Y(Math.max(c.o, c.c)));
      x.moveTo(Math.round(cx) + 0.5, Y(Math.min(c.o, c.c)));
      x.lineTo(Math.round(cx) + 0.5, Y(c.l));
      x.stroke();
      const t = Y(Math.max(c.o, c.c));
      const b = Y(Math.min(c.o, c.c));
      if (dex) {
        x.strokeRect(Math.round(cx - bw / 2) + 0.5, Math.round(t) + 0.5, Math.max(1, Math.round(bw) - 1), Math.max(1, Math.round(b - t)));
        x.globalAlpha = 1;
      } else x.fillRect(cx - bw / 2, t, bw, Math.max(1, b - t));
    });
    const used: number[] = [];
    st.ledger.positions
      .filter((p) => p.sym === sym)
      .map((p) => ({ p, e: toNumber(p.entry) }))
      .sort((a, b) => b.e - a.e)
      .forEach(({ p, e }) => {
        if (e < lo || e > hi) return;
        const yy = Math.round(Y(e)) + 0.5;
        const col = p.side === 'long' ? COL.up : COL.down;
        x.setLineDash([3, 4]);
        x.strokeStyle = col;
        x.globalAlpha = 0.8;
        x.beginPath();
        x.moveTo(0, yy);
        x.lineTo(cw, yy);
        x.stroke();
        x.setLineDash([]);
        x.globalAlpha = 1;
        let ty = yy;
        while (used.some((u) => Math.abs(u - ty) < 24)) ty += 24;
        used.push(ty);
        const lab = `${p.side === 'long' ? 'Long' : 'Short'} entry${st.veiled ? '' : ' ' + fmt(p.entry)}`;
        x.font = F(600);
        const tw = x.measureText(lab).width;
        x.fillStyle = col;
        rr(x, 8, ty - 10, tw + 14, 20, 5);
        x.fill();
        x.fillStyle = '#06110B';
        x.fillText(lab, 15, ty + 0.5);
      });
    const L = list[n - 1]!;
    const ly = Math.round(Y(tagPrice)) + 0.5;
    const up = L.c >= L.o;
    // Not a live price (stale feed, or no price at all): the last value is drawn grey and marked
    // "stale" under its tag, like the dimmed stale prices elsewhere (audit web F1).
    const live = priceState(lm, useMarkets.getState(), Date.now(), IS_MAINNET) === 'live';
    const col = !live ? COL.faint : up ? COL.up : COL.down;
    x.setLineDash([2, 3]);
    x.strokeStyle = col;
    x.globalAlpha = 0.6;
    x.beginPath();
    x.moveTo(0, ly);
    x.lineTo(cw, ly);
    x.stroke();
    x.globalAlpha = 1;
    x.setLineDash([]);
    x.fillStyle = live ? col : '#2A2D34';
    rr(x, cw + 4, ly - 10, AX - 6, 20, 5);
    x.fill();
    x.fillStyle = !live ? COL.faint : up ? '#03140B' : '#fff';
    x.font = F(600);
    x.fillText(fmt(tagPrice), cw + 12, ly + 0.5);
    if (!live) {
      x.fillStyle = COL.down;
      x.font = `500 10.5px ${font}`;
      x.fillText(mk(sym).closed ? CLOSED.tag : 'stale', cw + 12, ly + 19 > H - 6 ? ly - 19 : ly + 19);
    }
    let idx = n - 1;
    const hv0 = hover.current;
    if (hv0 && hv0.x < cw && hv0.y > PT && hv0.y < H - PB) {
      idx = Math.min(n - 1, Math.max(0, Math.floor(hv0.x / stp)));
      const hx = Math.round(idx * stp + stp / 2) + 0.5;
      const hy = Math.round(hv0.y) + 0.5;
      x.strokeStyle = 'rgba(255,255,255,.25)';
      x.setLineDash([3, 3]);
      x.beginPath();
      x.moveTo(hx, PT);
      x.lineTo(hx, H - PB);
      x.moveTo(0, hy);
      x.lineTo(cw, hy);
      x.stroke();
      x.setLineDash([]);
      const hv = hi - ((hy - PT) / (H - PT - PB)) * (hi - lo);
      x.fillStyle = '#2A2D34';
      rr(x, cw + 4, hy - 10, AX - 6, 20, 5);
      x.fill();
      x.fillStyle = COL.text;
      x.font = F(600);
      x.fillText(fmt(hv), cw + 12, hy + 0.5);
    }
    const c = list[idx]!;
    const d = readoutTime(c, st.tf);
    setOhlc((prev) => (prev && prev.d === d && prev.c.o === c.o && prev.c.h === c.h && prev.c.l === c.l && prev.c.c === c.c ? prev : { d, c: { ...c } }));
  }, [sym]);

  // Merge the live price into the last candle (and roll candles in local demo mode).
  useEffect(() => {
    const list = candles.current;
    const L = list[list.length - 1];
    if (!L) return;
    // No live price: the stored value is not data (it may be the config seed), so don't draw it. While the
    // market is closed the price is the frozen last quote: history (official or on-chain) is never rewritten with it.
    if (mk(sym).noData || mk(sym).closed) return draw();
    const p = mk(sym).priceNum;
    L.c = p;
    L.h = Math.max(L.h, p);
    L.l = Math.min(L.l, p);
    if (useLocal && ++localTicks.current % 10 === 0) {
      list.push({ t: L.t + TIMEFRAME_MS[tf], o: p, h: p, l: p, c: p });
      list.shift();
    }
    draw();
  }, [tick, sym, tf, useLocal, draw]);

  useEffect(() => {
    draw();
  }, [draw, veiled, positions, q.data, useLocal, feedStale]);

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(cv);
    const move = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      hover.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      draw();
    };
    const leave = () => {
      hover.current = null;
      draw();
    };
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerleave', leave);
    void document.fonts?.ready.then(() => draw());
    return () => {
      ro.disconnect();
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerleave', leave);
    };
  }, [draw]);

  const c = ohlc?.c;
  return (
    <>
      <div className="ohlc">
        {c ? (
          <>
            <span>{ohlc.d}</span>
            <span>
              O <b className="num">{fmt(c.o)}</b>
            </span>
            <span>
              H <b className="num">{fmt(c.h)}</b>
            </span>
            <span>
              L <b className="num">{fmt(c.l)}</b>
            </span>
            <span>
              C <b className={`num ${c.c >= c.o ? 'up' : 'down'}`}>{fmt(c.c)}</b>
            </span>
            {hasDex ? (
              <span className="dex-legend">
                <i aria-hidden="true" />
                {SESSION.dexLegend}
              </span>
            ) : null}
          </>
        ) : (
          // Keeps the row's height while there are no candles, so the chart does not jump.
          <span aria-hidden="true">&nbsp;</span>
        )}
      </div>
      <div className="chart">
        <canvas ref={cvRef} aria-label={`${sym} price chart`} role="img" />
        {unavailable ? <p className="chart-empty">Chart unavailable: price history could not be loaded.</p> : null}
        {!useLocal && !unavailable && apiEmpty ? <p className="chart-empty">Collecting live prices for this chart…</p> : null}
      </div>
    </>
  );
}
