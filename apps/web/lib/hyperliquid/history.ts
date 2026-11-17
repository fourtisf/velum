'use client';
/**
 * The user's perps history in the Velum markets: fills (realized P&L and fees) and hourly funding, summed for the
 * Portfolio and exported as CSV (spreadsheets, taxes). Read from Hyperliquid's userFills (the latest 2000 fills) and
 * userFunding (the last 90 days); pure helpers are unit-tested.
 */
import { HL_MARKETS } from '@velum/config/src/hyperliquid';
import { useQuery } from '@tanstack/react-query';
import { info, type HlFill } from './client';

export const HISTORY_DAYS = 90;

export interface HlFunding {
  time: number;
  coin: string;
  symbol: string;
  /** USDC paid (negative) or received (positive). */
  usdc: number;
  /** Position size at the payment (signed coins). */
  szi: string;
  /** Hourly rate, as a fraction. */
  rate: string;
}

const symbolOf = (coin: string): string | null => Object.values(HL_MARKETS).find((m) => m.coin === coin)?.symbol ?? null;
const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** The Velum markets' funding payments from a userFunding answer, newest first (pure). */
export function readFunding(list: unknown): HlFunding[] {
  if (!Array.isArray(list)) return [];
  const out: HlFunding[] = [];
  for (const u of list as Array<{ time?: unknown; delta?: Record<string, unknown> }>) {
    const d = u?.delta;
    if (!d || d.type !== 'funding' || typeof d.coin !== 'string' || typeof u.time !== 'number') continue;
    const symbol = symbolOf(d.coin);
    if (!symbol) continue;
    out.push({ time: u.time, coin: d.coin, symbol, usdc: n(d.usdc), szi: String(d.szi ?? '0'), rate: String(d.fundingRate ?? '0') });
  }
  return out.sort((a, b) => b.time - a.time);
}

/** The user's funding in the Velum markets over the last HISTORY_DAYS (weight 20; every 5 minutes, only while shown). */
export function useHlFunding(user: `0x${string}` | undefined, shown: boolean) {
  return useQuery({
    queryKey: ['hl-funding', user],
    enabled: !!user && shown,
    refetchInterval: 300_000,
    staleTime: 120_000,
    retry: 1,
    queryFn: async () => readFunding(await info.userFunding({ user: user!, startTime: Date.now() - HISTORY_DAYS * 86_400_000 })),
  });
}

export interface HistorySummary {
  realized: number;
  fees: number;
  funding: number;
  /** realized - fees + funding */
  net: number;
  trades: number;
  volume: number;
}

/** Sums of the fills and funding (pure). */
export function historySummary(fills: HlFill[], funding: HlFunding[]): HistorySummary {
  let realized = 0;
  let fees = 0;
  let volume = 0;
  for (const f of fills) {
    realized += n(f.closedPnl);
    fees += n(f.fee);
    volume += n(f.px) * n(f.sz);
  }
  const fund = funding.reduce((s, x) => s + x.usdc, 0);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { realized: r2(realized), fees: r2(fees), funding: r2(fund), net: r2(realized - fees + fund), trades: fills.length, volume: r2(volume) };
}

const cell = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** A CSV of every fill and funding payment, oldest first (pure). Times in UTC ISO 8601; amounts in USDC. */
export function historyCsv(fills: HlFill[], funding: HlFunding[]): string {
  const rows: Array<{ t: number; r: Array<string | number> }> = [];
  for (const f of fills)
    rows.push({ t: f.time, r: [new Date(f.time).toISOString(), 'trade', f.symbol, f.dir || 'Trade', f.sz, f.px, (n(f.px) * n(f.sz)).toFixed(2), f.fee, f.closedPnl, '', f.oid] });
  for (const x of funding) rows.push({ t: x.time, r: [new Date(x.time).toISOString(), 'funding', x.symbol, x.usdc >= 0 ? 'Funding received' : 'Funding paid', x.szi.replace(/^-/, ''), '', '', '', '', x.usdc.toFixed(6), ''] });
  rows.sort((a, b) => a.t - b.t);
  const head = ['time_utc', 'type', 'market', 'direction', 'size', 'price', 'notional_usdc', 'fee_usdc', 'realized_pnl_usdc', 'funding_usdc', 'order_id'];
  return [head, ...rows.map((x) => x.r)].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

/** Saves `text` as a file in the browser. */
export function download(name: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
