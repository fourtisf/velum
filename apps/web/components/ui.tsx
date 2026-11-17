'use client';
import { getMarket } from '@velum/config';
import { useEffect, useRef, type ElementType, type ReactNode } from 'react';
import { CLOSED, isDemoMetric, refTitle } from '@/lib/copy';
import { fmt, pct, usd } from '@/lib/format';
import { HL_PERPS } from '@/lib/hyperliquid/enabled';
import { LOGOS } from '@/lib/logos';
import { useMarket, usePriceState } from '@/lib/markets';

/** Company logo on a brand-colour disc (lib/logos.ts); USDG, ETH and unknown tokens use the neutral initial. */
export function Av({ sym, size = '' }: { sym: string; size?: '' | 'sm' | 'lg' }) {
  const logo = LOGOS[sym];
  if (logo)
    return (
      <span className={`av logo ${size}`.trim()} aria-hidden="true" style={{ background: logo.bg, color: logo.fg }}>
        {logo.path ? (
          <svg viewBox={logo.viewBox ?? '0 0 24 24'} fill="currentColor" fillRule={logo.viewBox ? 'evenodd' : undefined} focusable="false" style={logo.scale ? { width: `${logo.scale * 100}%`, height: `${logo.scale * 100}%` } : undefined}>
            {(Array.isArray(logo.path) ? logo.path : [logo.path]).map((d) => (
              <path key={d.slice(0, 24)} d={d} />
            ))}
          </svg>
        ) : (
          logo.text
        )}
      </span>
    );
  const ch = sym === 'USDG' ? '$' : sym === 'ETH' ? 'Ξ' : (getMarket(sym)?.name[0] ?? sym[0]);
  return (
    <span className={`av ${size}`.trim()} aria-hidden="true">
      {ch}
    </span>
  );
}

export const Pv = ({ children }: { children: ReactNode }) => <span className="pv">{children}</span>;

const prefersReduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Live price that flashes green/red when it changes (prototype data-px). No live price: a dash.
 * Mainnet, stale price (feed down or the API marks it stale): the last price, dimmed and marked
 * "stale" (audit round 2, M4). Testnet never shows the stale state (prototype behaviour).
 */
export function Px({ sym, raw, as, className }: { sym: string; raw?: boolean; as?: ElementType; className?: string }) {
  const Tag = (as ?? 'span') as ElementType;
  const m = useMarket(sym);
  const state = usePriceState(sym);
  const stale = state === 'stale';
  const txt = state === 'none' ? '—' : raw ? fmt(m.price) : usd(m.price);
  const ref = useRef<HTMLElement>(null);
  const prev = useRef(txt);
  useEffect(() => {
    if (prev.current === txt) return;
    prev.current = txt;
    const el = ref.current;
    if (!el || prefersReduced()) return;
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth;
    el.classList.add(m.dir >= 0 ? 'flash-up' : 'flash-down');
  }, [txt, m.dir]);
  return (
    <Tag ref={ref} className={stale ? `${className ?? ''} px-stale`.trim() : className} title={stale ? (m.closed ? CLOSED.title : 'Stale: no fresh price, trading paused') : undefined}>
      {txt}
      {stale ? <small className="stale-tag">{m.closed ? CLOSED.tag : 'stale'}</small> : null}
    </Tag>
  );
}

/** 24h change in percent (prototype data-chg). */
export function Chg({ sym, as, className = '' }: { sym: string; as?: ElementType; className?: string }) {
  const Tag = (as ?? 'span') as ElementType;
  const m = useMarket(sym);
  if (m.noData) return <Tag className={className}>—</Tag>;
  return <Tag className={`${className} ${m.chg >= 0 ? 'up' : 'down'}`.trim()}>{pct(m.chg)}</Tag>;
}

export function sparkPath(arr: number[], w: number, h: number): string {
  if (arr.length < 2) return '';
  const mn = Math.min(...arr);
  const mx = Math.max(...arr);
  const r = mx - mn || 1;
  return arr.map((v, i) => (i ? 'L' : 'M') + ((i / (arr.length - 1)) * w).toFixed(1) + ' ' + (3 + (1 - (v - mn) / r) * (h - 6)).toFixed(1)).join('');
}

/** Last-hour sparkline (prototype data-spark). */
export function Spark({ sym, w = 110, h = 30, className = 'spark', style }: { sym: string; w?: number; h?: number; className?: string; style?: React.CSSProperties }) {
  const m = useMarket(sym);
  const first = m.hist[0] ?? m.priceNum;
  return (
    <svg className={className} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" style={style}>
      <path d={sparkPath(m.hist, w, h)} stroke={m.priceNum >= first ? '#3FCF8E' : '#F25C61'} />
    </svg>
  );
}

export function ComingSoon() {
  return <span className="badge">Coming soon</span>;
}

/**
 * "Demo" beside a protocol metric that is demo data (DV-03): every such metric on testnet, and any the
 * API flags `demo: true` (lib/copy.ts isDemoMetric). Render it only where the metric itself is shown.
 */
/** The venue label of a perps metric taken from another venue's live market (mainnet), with what it means. */
export function RefTag({ venue, sym }: { venue: string; sym?: string }) {
  // Mainnet with live perps: the metrics are the traded market's own, so no venue label (owner request).
  if (HL_PERPS) return null;
  return (
    <span className="badge demo-tag" title={refTitle(venue, sym)}>
      {venue}
    </span>
  );
}

export function DemoTag({ flag }: { flag?: boolean }) {
  if (!isDemoMetric(flag)) return null;
  return (
    <span className="badge demo-tag" title="Demo data, not real trading activity">
      Demo
    </span>
  );
}
