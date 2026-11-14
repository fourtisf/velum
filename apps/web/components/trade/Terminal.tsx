'use client';
import { TIMEFRAMES } from '@velum/config';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { compact, fmt } from '@/lib/format';
import { useMarket, useMarkets } from '@/lib/markets';
import { METRICS } from '@/lib/copy';
import { useApp } from '@/lib/store';
import { Av, Chg, Px } from '../ui';
import { AccountCard } from './AccountCard';
import { Chart } from './Chart';
import { PositionsCard } from './Positions';
import { Ticket } from './Ticket';

function Strip({ sym, embedded }: { sym: string; embedded?: boolean }) {
  const order = useMarkets((s) => s.order);
  const bySym = useMarkets((s) => s.bySym);
  const set = useApp((s) => s.set);
  const router = useRouter();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const st = ref.current;
    const on = st?.querySelector<HTMLElement>('.mchip.on');
    if (st && on) st.scrollLeft = Math.max(0, on.offsetLeft - st.offsetLeft - st.clientWidth / 2 + on.clientWidth / 2);
  }, [sym]);
  const go = (s: string) => {
    if (embedded) set({ sel: s });
    else router.push(`/app/trade/${s}`);
  };
  return (
    <nav className="strip" aria-label="Markets" ref={ref}>
      {order.map((s) => (
        <button key={s} className={`mchip ${s === sym ? 'on' : ''}`} aria-current={s === sym ? 'true' : undefined} onClick={() => go(s)}>
          <Av sym={s} size="sm" />
          <b>{s}</b>
          <span className="sr">{bySym[s]!.name}</span>
          <Px sym={s} raw className="p num" />
          <Chg sym={s} className="num" />
        </button>
      ))}
    </nav>
  );
}

function ChartCard({ sym }: { sym: string }) {
  const m = useMarket(sym);
  const mode = useApp((s) => s.mode);
  const tf = useApp((s) => s.tf);
  const set = useApp((s) => s.set);
  return (
    <section className="card chartbox">
      <div className="ch-top">
        <div className="ch-id">
          <Av sym={sym} size="lg" />
          <div>
            <b>
              {sym}{' '}
              <span className="faint" style={{ fontWeight: 500 }}>
                / USDG
              </span>
            </b>
            <small>{m.name} stock token</small>
          </div>
        </div>
        <div className="seg" role="group" aria-label="Market type">
          <button className={mode === 'spot' ? 'on' : ''} aria-pressed={mode === 'spot'} onClick={() => set({ mode: 'spot' })}>
            Spot
          </button>
          <button className={mode === 'perps' ? 'on' : ''} aria-pressed={mode === 'perps'} onClick={() => set({ mode: 'perps' })}>
            Perps
          </button>
        </div>
        <div className="seg tf" role="group" aria-label="Timeframe">
          {TIMEFRAMES.map((t) => (
            <button key={t} className={t === tf ? 'on' : ''} aria-pressed={t === tf} onClick={() => set({ tf: t })}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="ch-stats">
        <div>
          <small>Price</small>
          <Px sym={sym} raw as="b" className="num big" />
        </div>
        <div>
          <small>24h change</small>
          <Chg sym={sym} as="b" className="num" />
        </div>
        <div>
          <small>Mark</small>
          <b className="num">{METRICS.real ? fmt(m.mark) : METRICS.dash}</b>
        </div>
        <div className="hide-sm">
          <small>Funding / h</small>
          <b className="num">{METRICS.real ? `${fmt(m.funding, 4)}%` : METRICS.dash}</b>
        </div>
        <div className="hide-sm">
          <small>Open interest</small>
          <b className="num">{METRICS.real ? compact(m.oi) : METRICS.dash}</b>
        </div>
      </div>
      <Chart sym={sym} />
    </section>
  );
}

/** The full trade terminal. `embedded` = the landing page hero (chips select in place). */
export function Terminal({ symbol, embedded }: { symbol?: string; embedded?: boolean }) {
  const storeSel = useApp((s) => s.sel);
  const sym = symbol ?? storeSel;
  return (
    <>
      <Strip sym={sym} embedded={embedded} />
      <div className="tr-grid">
        <div className="lcol">
          <ChartCard sym={sym} />
          <PositionsCard />
        </div>
        <div className="rcol">
          <Ticket sym={sym} />
          <AccountCard />
        </div>
      </div>
    </>
  );
}
