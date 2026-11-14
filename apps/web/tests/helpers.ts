/**
 * Test helpers (not a test file). Network-dependent test files set NEXT_PUBLIC_VELUM_NETWORK in
 * vi.hoisted() before anything imports @velum/config, so import this module after that.
 */
import { MARKETS } from '@velum/config';
import { parseWad, toNumber, type Wad } from '@velum/math';
import { Fragment, createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { receiptRows } from '@/lib/demo';
import { useMarkets, type LiveMarket } from '@/lib/markets';
import { SIM } from '@/lib/copy';
import { useApp, type FlowResult, type FlowSpec } from '@/lib/store';

export const W = (s: string): Wad => parseWad(s)!;
export const WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
export const PADDR = 'velum1' + 'a'.repeat(36);

/** A Map-backed Storage on globalThis.localStorage (the code under test wraps every access in try/catch). */
export function installStorage(initial: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(initial));
  const st: Storage = {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
  (globalThis as { localStorage?: Storage }).localStorage = st;
  return st;
}

/** Every market live (fresh feed) at its seed price or the given price. */
export function setLiveMarkets(prices: Record<string, string> = {}, now = Date.now()) {
  useMarkets.setState((s) => {
    const bySym = { ...s.bySym };
    for (const m of MARKETS) {
      const price = W(prices[m.symbol] ?? m.seedPrice);
      bySym[m.symbol] = { ...bySym[m.symbol]!, price, priceNum: toNumber(price), mark: price, noData: false, stale: false };
    }
    return { bySym, source: 'api', lastOkAt: now, failures: 0, feedStale: false, tick: s.tick + 1 };
  });
}

export function patchMarket(sym: string, patch: Partial<LiveMarket>) {
  useMarkets.setState((s) => ({ bySym: { ...s.bySym, [sym]: { ...s.bySym[sym]!, ...patch } }, tick: s.tick + 1 }));
}

/** Plain text of React nodes (receipt rows hold elements). */
export function text(nodes: ReactNode[]): string {
  const html = renderToStaticMarkup(createElement(Fragment, null, ...nodes.map((n, i) => createElement('span', { key: i }, n, ' '))));
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The flow the last action started (it is in the modal), cleared from the store. */
export function takeFlow(): FlowSpec {
  const m = useApp.getState().modal;
  if (m?.kind !== 'flow') throw new Error('no flow started');
  useApp.setState({ modal: null, modalLocked: false });
  return m.flow;
}

/** Everything a user reads in a flow: title, steps and the receipt as the dialog shows it. */
export function flowText(f: FlowSpec, r: FlowResult): string {
  return [SIM.flowTitle(f.title), ...f.steps.flatMap((s) => [s.t, s.d ?? '']), text(receiptRows(r.rows).flat()), r.toast].join('\n');
}

export function connect(ledger = useApp.getState().ledger) {
  useApp.setState({ account: { addr: WALLET, paddr: PADDR }, ledger, modal: null, modalLocked: false });
}
