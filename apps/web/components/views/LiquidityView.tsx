'use client';
import { POOLS, isLive } from '@velum/config';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { lpRemove } from '@/lib/demo';
import { compact, fmt, usdBal } from '@/lib/format';
import { WALLET_ONLY, useOnchain } from '@/lib/onchain/deployment';
import { ComingSoon } from './ComingSoon';
import { bal, useApp } from '@/lib/store';
import { OcLiquidityView } from '../onchain/lazy';
import { METRICS, P, UI } from '@/lib/copy';
import { I } from '../icons';
import { Av, DemoTag, Px } from '../ui';

function PoolCard({ s, size, apr, demo }: { s: string; size: number; apr: number; demo?: boolean }) {
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
        <span className="badge">{P.poolFee} fee</span>
      </div>
      <div className="kv">
        <div>
          <small>
            Pool size{METRICS.real ? <DemoTag flag={demo} /> : null}
          </small>
          <b>{METRICS.real ? `~${compact(size)}` : METRICS.dash}</b>
        </div>
        <div>
          <small>
            Est. APR{METRICS.real ? <DemoTag flag={demo} /> : null}
          </small>
          <b className={METRICS.real ? 'up' : ''}>{METRICS.real ? `${fmt(apr, 1)}%` : METRICS.dash}</b>
        </div>
        <div>
          <small>Your liquidity</small>
          <b className={mine ? 'pv' : ''}>{mine ? usdBal(mine) : 'None'}</b>
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

const EARN_SOON = "Earning pool fees needs Velum's own pools, which open after an external audit. Until then you can buy and sell Stock Tokens through Uniswap and trade perps from your own account.";

export function LiquidityView() {
  const oc = useOnchain();
  return oc ? <OcLiquidityView oc={oc} /> : WALLET_ONLY ? <ComingSoon title="Earn" text={EARN_SOON} /> : <DemoLiquidityView />;
}

function DemoLiquidityView() {
  const pools = useQuery({ queryKey: ['pools'], queryFn: ({ signal }) => api.pools(signal), refetchInterval: 60_000, retry: 1 });
  const list = POOLS.map((p) => {
    const d = pools.data?.find((x) => x.symbol === p.symbol);
    return { s: p.symbol, size: Number(d?.sizeRounded ?? p.size), apr: Number(d?.aprEst ?? p.aprEst), demo: d?.demo };
  });
  return (
    <>
      <div className="vhead">
        <div>
          <h1 className="vtitle">Earn</h1>
          <p className="vsub">{UI.earnSub}</p>
        </div>
      </div>
      <div className="pools">
        {list.map((p) => (
          <PoolCard key={p.s} {...p} />
        ))}
      </div>
      <div className="boxnote" style={{ maxWidth: 760 }}>
        <I.info />
        <span>{UI.earnNote}</span>
      </div>
    </>
  );
}
