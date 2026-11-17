'use client';
/**
 * Puts the user's real perps position in `sym` on the chart: its entry and liquidation price, its take profit and stop
 * loss, and resting limit orders (lib/chartLines.ts). Renders nothing; clears the lines when it unmounts.
 */
import { useEffect } from 'react';
import { positionLines, useChartLines } from '@/lib/chartLines';
import { fmt } from '@/lib/format';
import { useHlBalances, useHlMarkets, useHlMode } from '@/lib/hyperliquid/client';
import { useHlOpenOrders } from '@/lib/hyperliquid/manage';
import { tpslOf } from '@/lib/hyperliquid/risk';
import { useApp } from '@/lib/store';

const num = (v: string | null | undefined): number | null => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : null;
};

export function HlChartLines({ sym }: { sym: string }) {
  const user = useApp((s) => s.account?.addr);
  const mode = useHlMode(user);
  const bal = useHlBalances(user, mode.data);
  const orders = useHlOpenOrders(user);
  const markets = useHlMarkets();
  const setLines = useChartLines((s) => s.setLines);
  const coin = markets.data?.[sym]?.coin ?? null;
  const pos = coin ? (bal.data?.positions.find((p) => p.coin === coin) ?? null) : null;
  const list = orders.data ?? [];
  const ts = coin ? tpslOf(list, coin) : { tp: null, sl: null };
  const limits = coin ? list.filter((o) => o.coin === coin && o.kind === 'limit').map((o) => ({ isBuy: o.isBuy, px: num(o.px) ?? 0 })).filter((l) => l.px > 0) : [];
  const lines = positionLines({
    pos: pos && num(pos.entryPx) ? { long: !pos.szi.startsWith('-'), entry: num(pos.entryPx)!, liq: num(pos.liquidationPx) } : null,
    tp: num(ts.tp?.px),
    sl: num(ts.sl?.px),
    limits,
    fmt: (n) => fmt(n),
  });
  const key = JSON.stringify(lines);
  useEffect(() => {
    setLines(sym, JSON.parse(key));
  }, [sym, key, setLines]);
  useEffect(() => () => setLines(sym, []), [sym, setLines]);
  return null;
}
