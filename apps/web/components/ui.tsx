'use client';
import { explorerAddressUrl, getMarket } from '@velum/config';
import { useEffect, useId, useRef, type ElementType, type ReactNode, type SyntheticEvent } from 'react';
import { CLOSED, PERPS_HINT, SESSION, isDemoMetric } from '@/lib/copy';
import { ago, compact, fmt, pct, shortH, usd } from '@/lib/format';
import { LOGOS } from '@/lib/logos';
import { changeView, useMarket, useMarkets, usePriceState, type DexDisplay, type LiveMarket } from '@/lib/markets';

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

/**
 * Change in percent (prototype data-chg): the rolling 24 h while the market is open, exactly as before. While it is
 * closed, the last session's change with a small muted "· last session", or with `dex` and an on-chain DEX price,
 * the DEX change since the last close ("· since close"). A change the history cannot give is a dash.
 */
export function Chg({ sym, as, className = '', dex = false, compact = false }: { sym: string; as?: ElementType; className?: string; dex?: boolean; compact?: boolean }) {
  return <ChgText m={useMarket(sym)} as={as} className={className} dex={dex} compact={compact} />;
}

/** Chg for a given market (pure presentation). `compact`: no label after a DEX change (the strip's DEX tag sits next to it). */
export function ChgText({ m, as, className = '', dex = false, compact = false }: { m: LiveMarket; as?: ElementType; className?: string; dex?: boolean; compact?: boolean }) {
  const Tag = (as ?? 'span') as ElementType;
  if (m.noData) return <Tag className={className}>—</Tag>;
  const v = changeView(m, dex);
  const label = v.basis === '24h' || (compact && v.basis === 'dex') ? null : <span className="chg-basis">· {v.basis === 'dex' ? SESSION.sinceClose : SESSION.lastSession}</span>;
  if (v.value === null)
    return (
      <Tag className={className}>
        —{label}
      </Tag>
    );
  return (
    <Tag className={`${className} ${v.value >= 0 ? 'up' : 'down'}`.trim()}>
      {pct(v.value)}
      {label}
    </Tag>
  );
}

/** The change column's header: "24h" as before; "Change" while the markets show the last session's change (closed). */
export function ChgHeader() {
  const closed = useMarkets((s) => Object.values(s.bySym).some((m) => !m.noData && m.chgBasis === 'lastSession'));
  return <>{closed ? 'Change' : '24h'}</>;
}

/**
 * A dash for a protocol metric with no source yet (mainnet: mark, funding, open interest), with the hint "Live when
 * perps launch": a keyboard-focusable tooltip (aria-describedby), or in table cells (`inline`) a native title and
 * visually hidden text, so a table does not gain a tab stop per cell. No layout change: the tooltip floats.
 */
export function PerpsDash({ inline = false }: { inline?: boolean }) {
  const id = useId();
  if (inline)
    return (
      <span title={PERPS_HINT}>
        —<span className="sr"> {PERPS_HINT}</span>
      </span>
    );
  return (
    <span className="tip" onMouseEnter={fitTip} onFocus={fitTip}>
      <span className="tip-dash" tabIndex={0} aria-describedby={id}>
        —
      </span>
      <span role="tooltip" id={id} className="tip-box">
        {PERPS_HINT}
      </span>
    </span>
  );
}

/** Keeps an open tooltip inside the viewport: anchored to the trigger's right edge when it would stick out. */
function fitTip(e: SyntheticEvent<HTMLElement>) {
  const box = e.currentTarget.querySelector<HTMLElement>('.tip-box');
  if (!box) return;
  box.classList.remove('tip-r');
  if (box.getBoundingClientRect().right > window.innerWidth - 8) box.classList.add('tip-r');
}

/** "On-chain · DEX" in the strip chip: the DEX price, its pool and liquidity in the chip's title (the chip is a button). */
export function DexChip({ sym }: { sym: string }) {
  const m = useMarket(sym);
  if (m.noData || !m.dex) return null;
  const tip = dexTipText(m.dex);
  return (
    <span className="dexpx num" title={tip}>
      <span className="dex-tag">{SESSION.dexTag}</span> {fmt(m.dex.price)}
      <span className="sr">, {tip}</span>
    </span>
  );
}

/** Plain-text tooltip of a DEX price: source, pool address, liquidity, trade time. */
export function dexTipText(d: DexDisplay, now = Date.now()): string {
  return [
    SESSION.dexTipTitle,
    `${SESSION.dexTipPool} ${d.pool}`,
    d.liquidity !== null ? `${SESSION.dexTipLiquidity} ${compact(d.liquidity)}` : null,
    d.tradeAt !== null ? `${SESSION.dexTipTrade} ${ago(d.tradeAt, now).toLowerCase()}` : null,
    d.closeRef !== null ? `${SESSION.dexTipClose} ${fmt(d.closeRef)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The on-chain DEX price in the trade stats, with a tooltip (hover or keyboard focus) holding the pool address linked
 * to the explorer, its liquidity and the last trade time. Display only; the official last quote stays the price.
 */
export function DexStat({ sym }: { sym: string }) {
  const id = useId();
  const m = useMarket(sym);
  if (m.noData || !m.dex) return null;
  const d = m.dex;
  return (
    <div className="dex-stat">
      <small>{SESSION.dexStat}</small>
      <span className="tip" onMouseEnter={fitTip} onFocus={fitTip}>
        <button type="button" className="tip-btn num" aria-describedby={id}>
          {fmt(d.price)}
        </button>
        <span id={id} className="tip-box tip-wide">
          <span className="tip-title">{SESSION.dexTipTitle}</span>
          <span>
            {SESSION.dexTipPool}{' '}
            <a className="lnk mono" href={explorerAddressUrl(d.pool)} target="_blank" rel="noopener noreferrer">
              {shortH(d.pool)}
            </a>
          </span>
          {d.liquidity !== null ? (
            <span>
              {SESSION.dexTipLiquidity} {compact(d.liquidity)}
            </span>
          ) : null}
          {d.tradeAt !== null ? (
            <span>
              {SESSION.dexTipTrade} {ago(d.tradeAt).toLowerCase()}
            </span>
          ) : null}
          {d.closeRef !== null ? (
            <span>
              {SESSION.dexTipClose} {fmt(d.closeRef)}
            </span>
          ) : null}
          <span>{SESSION.dexTipNote}</span>
        </span>
      </span>
    </div>
  );
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
export function DemoTag({ flag }: { flag?: boolean }) {
  if (!isDemoMetric(flag)) return null;
  return (
    <span className="badge demo-tag" title="Demo data, not real trading activity">
      Demo
    </span>
  );
}
