'use client';
/**
 * Price lines the chart draws on top of the candles for one market: a real perps position's entry and liquidation, its
 * take profit and stop loss, and resting limit orders (components/hyperliquid/HlChartLines.tsx writes them; the chart in
 * components/trade/Chart.tsx reads them). Kept apart from the app store so the chart redraws only when they change.
 */
import { create } from 'zustand';

export type LineTone = 'up' | 'down' | 'warn' | 'acc';
export interface ChartLine {
  price: number;
  label: string;
  tone: LineTone;
  /** Dashed (orders and estimates) or solid (the entry). */
  dashed: boolean;
}

interface LinesState {
  lines: Record<string, ChartLine[]>;
  setLines: (sym: string, lines: ChartLine[]) => void;
}

const same = (a: ChartLine[] | undefined, b: ChartLine[]) => !!a && a.length === b.length && a.every((l, i) => l.price === b[i]!.price && l.label === b[i]!.label && l.tone === b[i]!.tone);

export const useChartLines = create<LinesState>((set, get) => ({
  lines: {},
  setLines: (sym, lines) => {
    if (same(get().lines[sym], lines)) return;
    set((s) => ({ lines: { ...s.lines, [sym]: lines } }));
  },
}));

/** Lines for a position and its orders (pure, for tests). */
export function positionLines(p: {
  pos: { long: boolean; entry: number; liq: number | null } | null;
  tp: number | null;
  sl: number | null;
  limits: Array<{ isBuy: boolean; px: number }>;
  fmt: (n: number) => string;
}): ChartLine[] {
  const out: ChartLine[] = [];
  if (p.pos) {
    out.push({ price: p.pos.entry, label: `${p.pos.long ? 'Long' : 'Short'} entry ${p.fmt(p.pos.entry)}`, tone: p.pos.long ? 'up' : 'down', dashed: false });
    if (p.pos.liq !== null && p.pos.liq > 0) out.push({ price: p.pos.liq, label: `Liq. ${p.fmt(p.pos.liq)}`, tone: 'warn', dashed: true });
  }
  if (p.tp !== null) out.push({ price: p.tp, label: `TP ${p.fmt(p.tp)}`, tone: 'up', dashed: true });
  if (p.sl !== null) out.push({ price: p.sl, label: `SL ${p.fmt(p.sl)}`, tone: 'down', dashed: true });
  for (const l of p.limits) out.push({ price: l.px, label: `Limit ${l.isBuy ? 'buy' : 'sell'} ${p.fmt(l.px)}`, tone: 'acc', dashed: true });
  return out;
}
