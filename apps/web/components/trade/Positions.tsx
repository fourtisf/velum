'use client';
import { Fragment } from 'react';
import { posPnl } from '@/lib/calc';
import { closePos } from '@/lib/demo';
import { ago, fmt, fmtLev, pct, sgnUsd, shortH } from '@/lib/format';
import { useMarkets } from '@/lib/markets';
import { useApp, type Activity, type Position } from '@/lib/store';
import { toNumber } from '@velum/math';
import { Icon } from '../icons';
import { Av, Pv, Px } from '../ui';

function PnlCell({ p }: { p: Position }) {
  useMarkets((s) => s.tick);
  const v = posPnl(p);
  const r = p.margin > 0n ? (toNumber(v) / toNumber(p.margin)) * 100 : 0;
  return (
    <td className="r num">
      <Pv>
        <span className={v >= 0n ? 'up' : 'down'}>
          {sgnUsd(v)} <small>{pct(r, 1)}</small>
        </span>
      </Pv>
    </td>
  );
}

export function PosTable({ list, wide }: { list: Position[]; wide?: boolean }) {
  const openChain = useApp((s) => s.openChain);
  const set = useApp((s) => s.set);
  const cols = wide ? 9 : 6;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Market</th>
            {wide ? <th>Side</th> : null}
            <th className="r">Size</th>
            <th className="r">Entry</th>
            {wide ? <th className="r">Mark</th> : null}
            <th className="r hide-sm">Liq. price</th>
            {wide ? <th className="r hide-sm">Margin</th> : null}
            <th className="r">P&amp;L</th>
            <th className="r">
              <span className="sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => {
            const Side = p.side === 'long' ? 'Long' : 'Short';
            const sc = p.side === 'long' ? 'up' : 'down';
            const open = !!openChain[p.id];
            return (
              <Fragment key={p.id}>
                <tr>
                  <td>
                    <div className="mcell">
                      <Av sym={p.sym} size="sm" />
                      <div>
                        <b>{p.sym}</b>
                        <small className={wide ? '' : sc}>{wide ? fmtLev(p.lev) : Side + ' ' + fmtLev(p.lev)}</small>
                      </div>
                    </div>
                  </td>
                  {wide ? (
                    <td className={sc} style={{ fontWeight: 500 }}>
                      {Side}
                    </td>
                  ) : null}
                  <td className="r num">
                    <Pv>{fmt(p.qty, 4)}</Pv>
                  </td>
                  <td className="r num">
                    <Pv>{fmt(p.entry)}</Pv>
                  </td>
                  {wide ? <Px sym={p.sym} raw as="td" className="r num" /> : null}
                  <td className="r num hide-sm">
                    <Pv>{p.liq ? fmt(p.liq) : 'None'}</Pv>
                  </td>
                  {wide ? (
                    <td className="r num hide-sm">
                      <Pv>{fmt(p.margin)}</Pv>
                    </td>
                  ) : null}
                  <PnlCell p={p} />
                  <td className="r">
                    <div className="rowbtns">
                      <button className="btn btn-ghost btn-sm hide-sm" aria-expanded={open} onClick={() => set({ openChain: { ...openChain, [p.id]: !open } })}>
                        Chain view
                      </button>
                      <button className="btn btn-dark btn-sm" onClick={() => closePos(p.id)}>
                        Close
                      </button>
                    </div>
                  </td>
                </tr>
                <tr className="chainrow" hidden={!open}>
                  <td colSpan={cols}>
                    <div className="chainbox">
                      <div>
                        What the public chain sees<b>A position changed in {p.sym}</b>
                      </div>
                      <div>
                        Commitment<b>{shortH(p.commit)}</b>
                      </div>
                      <div>
                        Block<b className="num">{fmt(p.block, 0)}</b>
                      </div>
                      <div>
                        Size, side, price, owner<b>Hidden</b>
                      </div>
                    </div>
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ActList({ list, n }: { list: Activity[]; n: number }) {
  if (!list.length)
    return (
      <div className="empty">
        <p>No activity yet.</p>
      </div>
    );
  return (
    <>
      {list.slice(0, n).map((h, i) => (
        <div className="act" key={h.t + ':' + i}>
          <span className="ic">
            <Icon name={h.icon} />
          </span>
          <div>
            <b className="pv">{h.title}</b>
            <small>{h.sub}</small>
          </div>
          <small className="faint" suppressHydrationWarning>
            {ago(h.t)}
          </small>
        </div>
      ))}
    </>
  );
}

export function PositionsCard() {
  const s = useApp();
  const connected = !!s.account;
  const { positions, history } = s.ledger;
  let body: React.ReactNode;
  if (s.ptab === 'pos') {
    if (!connected)
      body = (
        <div className="empty">
          <p>Connect your wallet to see your private positions.</p>
          <button className="btn btn-white btn-sm" onClick={() => s.openModal({ kind: 'connect' })}>
            Connect wallet
          </button>
        </div>
      );
    else if (!positions.length)
      body = (
        <div className="empty">
          <p>No open positions. Pick long or short in the ticket to open one.</p>
        </div>
      );
    else body = <PosTable list={positions} />;
  } else
    body = connected ? (
      <ActList list={history} n={10} />
    ) : (
      <div className="empty">
        <p>Connect your wallet to see your activity.</p>
      </div>
    );
  return (
    <section className="card posbox">
      <div className="ptabs" role="tablist">
        <button role="tab" aria-selected={s.ptab === 'pos'} className={s.ptab === 'pos' ? 'on' : ''} onClick={() => s.set({ ptab: 'pos' })}>
          Positions<span className="count num">{positions.length}</span>
        </button>
        <button role="tab" aria-selected={s.ptab === 'hist'} className={s.ptab === 'hist' ? 'on' : ''} onClick={() => s.set({ ptab: 'hist' })}>
          Activity
        </button>
      </div>
      <div role="tabpanel">{body}</div>
    </section>
  );
}
