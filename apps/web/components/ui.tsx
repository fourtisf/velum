'use client';
import { getMarket } from '@velum/config';
import { useEffect, useRef, type ElementType, type ReactNode } from 'react';
import { fmt, pct, usd } from '@/lib/format';
import { LOGOS } from '@/lib/logos';
import { useMarket } from '@/lib/markets';

/** Company logo on a brand-colour disc (lib/logos.ts); USDG, ETH and unknown tokens use the neutral initial. */
export function Av({ sym, size = '' }: { sym: string; size?: '' | 'sm' | 'lg' }) {
  const logo = LOGOS[sym];
  if (logo)
    return (
      <span className={`av logo ${size}`.trim()} aria-hidden="true" style={{ background: logo.bg, color: logo.fg }}>
        {logo.path ? (
          <svg viewBox="0 0 24 24" fill="currentColor" focusable="false" style={logo.scale ? { width: `${logo.scale * 100}%`, height: `${logo.scale * 100}%` } : undefined}>
            <path d={logo.path} />
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

/** Live price that flashes green/red when it changes (prototype data-px). */
export function Px({ sym, raw, as, className }: { sym: string; raw?: boolean; as?: ElementType; className?: string }) {
  const Tag = (as ?? 'span') as ElementType;
  const m = useMarket(sym);
  const txt = m.noData ? '—' : raw ? fmt(m.price) : usd(m.price);
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
    <Tag ref={ref} className={className}>
      {txt}
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
