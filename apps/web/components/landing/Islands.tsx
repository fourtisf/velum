'use client';
/** Client islands for the landing page (everything else there is static HTML). */
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fromNumber, pnl } from '@velum/math';
import { METRICS } from '@/lib/copy';
import { compact, fmt, sgnUsd } from '@/lib/format';
import { useMarket, useMarkets } from '@/lib/markets';
import { Av, Chg, ComingSoon, Px, Spark } from '../ui';
import { Terminal } from '../trade/Terminal';

/** Live demo terminal: starts tilted, settles flat when 18% visible. */
export function HeroFrame() {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setIn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
      setIn(true);
      return;
    }
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) {
            setIn(true);
            io.disconnect();
          }
        }),
      { threshold: 0.18 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div className="frame-wrap">
      <div className={`frame ${inView ? 'in' : ''}`} ref={ref}>
        <div className="frame-in">
          <Terminal embedded />
        </div>
      </div>
    </div>
  );
}

export function RevealCard({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`bc span2 reveal ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)}>
      {children}
    </div>
  );
}

export function PoolSpark() {
  return <Spark sym="TSLA" w={300} h={60} style={{ width: '100%', height: 60, marginTop: 12 }} />;
}

const EX = { q: fromNumber(13.35), E: fromNumber(374.57) };

/** "Same trade. Two very different views." rows; the private side shows live P&L. */
export function PrivacyRows({ priv }: { priv: boolean }) {
  const m = useMarket('TSLA');
  const pl = pnl('long', EX.q, EX.E, m.price);
  const R: Array<[string, ReactNode, boolean]> = [
    ['Deposit', '5,000 USDG', true],
    ['Market', 'TSLA perp', true],
    ['Side', <span key="s" className="up">Long 2×</span>, false],
    ['Size', `${fmt(EX.q, 2)} TSLA`, false],
    ['Entry price', fmt(EX.E), false],
    ['Profit and loss', <span key="p" className={pl >= 0n ? 'up' : 'down'}>{sgnUsd(pl)}</span>, false],
  ];
  return (
    <div>
      {R.map(([k, v, pub]) => (
        <div className="prow" key={k}>
          <span>{k}</span>
          {priv || pub ? <b className="num">{v}</b> : <i className="hidden-bar" role="img" aria-label="Hidden" />}
        </div>
      ))}
    </div>
  );
}

export function LandingMarkets() {
  const order = useMarkets((s) => s.order).slice(0, 6);
  const bySym = useMarkets((s) => s.bySym);
  return (
    <tbody>
      {order.map((s) => {
        const m = bySym[s]!;
        return (
          <tr key={s}>
            <td>
              <div className="mcell">
                <Av sym={s} />
                <div>
                  <b>{s}</b>
                  <small>{m.name}</small>
                </div>
              </div>
            </td>
            <Px sym={s} as="td" className="r num" />
            <Chg sym={s} as="td" className="r num" />
            <td className="hide-sm">
              <Spark sym={s} />
            </td>
            <td className="r num hide-sm">{METRICS.real ? compact(m.oi) : METRICS.dash}</td>
            <td className="r">
              {m.status === 'live' ? (
                <Link className="btn btn-dark btn-sm" href={`/app/trade/${s}?mode=perps`}>
                  Trade
                </Link>
              ) : (
                <ComingSoon />
              )}
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}
