'use client';
import { POOLS, isLive } from '@velum/config';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { lpRemove } from '@/lib/demo';
import { compact, fmt, usd } from '@/lib/format';
import { bal, useApp } from '@/lib/store';
import { I } from '../icons';
import { Av, Px } from '../ui';

function PoolCard({ s, size, apr }: { s: string; size: number; apr: number }) {
  const app = useApp();
  const mine = bal(app.ledger.lp, s);
  const live = isLive(s);
  const add = () => (app.account ? app.openModal({ kind: 'lpadd', sym: s }) : app.openModal({ kind: 'connect' }));
  return (
    <div className="card pool">
      <div className="pool-h">
        <span className="pair">
          <Av sym={s} size="sm" />
          <Av sym="USDG" size="sm" />
        </span>
        <b>{s} / USDG</b>
        <span className="badge">0.30% fee</span>
      </div>
      <div className="kv">
        <div>
          <small>Pool size</small>
          <b>~{compact(size)}</b>
        </div>
        <div>
          <small>Est. APR</small>
          <b className="up">{fmt(apr, 1)}%</b>
        </div>
        <div>
          <small>Your liquidity</small>
          <b className={mine ? 'pv' : ''}>{mine ? usd(mine) : 'None'}</b>
        </div>
        <div>
          <small>Price</small>
          <Px sym={s} as="b" />
        </div>
      </div>
      <div className="rowbtns">
        {mine ? (
          <button className="btn btn-dark btn-sm" onClick={() => lpRemove(s)}>
            Remove
          </button>
        ) : null}
        {live ? (
          <button className="btn btn-white btn-sm" onClick={add}>
            Add liquidity
          </button>
        ) : (
          <button className="btn btn-dark btn-sm" disabled>
            Coming soon
          </button>
        )}
      </div>
    </div>
  );
}

export function LiquidityView() {
  const pools = useQuery({ queryKey: ['pools'], queryFn: ({ signal }) => api.pools(signal), refetchInterval: 60_000, retry: 1 });
  const list = POOLS.map((p) => {
    const d = pools.data?.find((x) => x.symbol === p.symbol);
    return { s: p.symbol, size: Number(d?.sizeRounded ?? p.size), apr: Number(d?.aprEst ?? p.aprEst) };
  });
  return (
    <>
      <div className="vhead">
        <div>
          <h1 className="vtitle">Earn</h1>
          <p className="vsub">Add to a private pool and earn 0.30% of every swap through it. Public pool sizes are rounded and published hourly.</p>
        </div>
      </div>
      <div className="pools">
        {list.map((p) => (
          <PoolCard key={p.s} {...p} />
        ))}
      </div>
      <div className="boxnote" style={{ maxWidth: 760 }}>
        <I.info />
        <span>Hourly totals only appear when an hour has at least 10 fills from at least 2 makers, rounded to two significant figures, so no single trade stands out.</span>
      </div>
    </>
  );
}
