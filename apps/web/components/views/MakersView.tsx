'use client';
import { MARKETS, isLive } from '@velum/config';
import { parseOrZero } from '@velum/math';
import { useState } from 'react';
import { earnPer1000, postOffer, withdrawOffer } from '@/lib/demo';
import { fmt, usd } from '@/lib/format';
import { bal, useApp } from '@/lib/store';
import { I } from '../icons';
import { Av, Pv } from '../ui';

const EXPIRIES = ['6 hours', '24 hours', '7 days'];

function Offers() {
  const s = useApp();
  if (!s.account)
    return (
      <div className="empty">
        <p>Connect your wallet to post and manage offers.</p>
      </div>
    );
  if (!s.ledger.offers.length)
    return (
      <div className="empty">
        <p>No offers yet. Post one to start backing trades.</p>
      </div>
    );
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Market</th>
            <th className="r">Backing</th>
            <th className="r">Fills</th>
            <th className="r">Earned</th>
            <th className="r hide-sm">Spreads</th>
            <th className="r hide-sm">Ends</th>
            <th className="r">
              <span className="sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {s.ledger.offers.map((o) => (
            <tr key={o.id}>
              <td>
                <div className="mcell">
                  <Av sym={o.sym} size="sm" />
                  <b>{o.sym}</b>
                </div>
              </td>
              <td className="r num">
                <Pv>{fmt(o.back, 0) + ' USDG'}</Pv>
              </td>
              <td className="r num">{o.fills}</td>
              <td className="r num">
                <Pv>
                  <span className="up">{usd(o.earned)}</span>
                </Pv>
              </td>
              <td className="r num hide-sm">
                {o.open} / {o.close} bps
              </td>
              <td className="r hide-sm faint">in {o.exp}</td>
              <td className="r">
                <button className="btn btn-dark btn-sm" onClick={() => withdrawOffer(o.id)}>
                  Withdraw
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MakersView() {
  const s = useApp();
  const [sym, setSym] = useState(isLive(s.sel) ? s.sel : 'TSLA');
  const [back, setBack] = useState('5000');
  const [max, setMax] = useState('1000');
  const [open, setOpen] = useState('8');
  const [close, setClose] = useState('5');
  const v = { sym, back: parseOrZero(back), max: parseOrZero(max), open: Number.parseFloat(open) || 0, close: Number.parseFloat(close) || 0 };
  const have = bal(s.ledger.priv, 'USDG');
  let hint = '';
  let b: { label: string; cls: string; disabled: boolean; onClick?: () => void };
  if (!s.account) b = { label: 'Connect wallet', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'connect' }) };
  else if (v.back <= 0n) b = { label: 'Enter backing', cls: 'btn-dark', disabled: true };
  else if (v.back > have) {
    b = { label: 'Not enough private USDG', cls: 'btn-dark', disabled: true };
    hint = `You have ${fmt(have)} USDG available.`;
  } else if (v.max <= 0n || v.max > v.back) {
    b = { label: 'Check your largest fill', cls: 'btn-dark', disabled: true };
    hint = 'The largest fill must be above zero and no more than your backing.';
  } else b = { label: 'Post offer', cls: 'btn-white', disabled: false, onClick: () => postOffer(v) };

  return (
    <>
      <div className="vhead">
        <div>
          <h1 className="vtitle">Maker desk</h1>
          <p className="vsub">Back traders&apos; positions from your private balance and earn the spread. You take the other side of every fill.</p>
        </div>
      </div>
      <div className="mk-grid">
        <section className="card form">
          <h2>Post a standing offer</h2>
          <div className="fl">
            <label htmlFor="of-mkt">Market</label>
          </div>
          <select className="sel full" id="of-mkt" value={sym} onChange={(e) => setSym(e.target.value)}>
            {MARKETS.map((m) => (
              <option key={m.symbol} value={m.symbol} disabled={m.status !== 'live'}>
                {m.status === 'live' ? m.symbol : `${m.symbol} (coming soon)`}
              </option>
            ))}
          </select>
          <div className="fl">
            <label htmlFor="of-back">Backing</label>
            <span>
              Available <b className="num pv">{s.account ? fmt(have) + ' USDG' : '—'}</b>
            </span>
          </div>
          <div className="inp sm">
            <input id="of-back" inputMode="decimal" value={back} autoComplete="off" onChange={(e) => setBack(e.target.value)} />
            <span className="unit">USDG</span>
          </div>
          <div className="fl">
            <label htmlFor="of-max">Largest single fill</label>
          </div>
          <div className="inp sm">
            <input id="of-max" inputMode="decimal" value={max} autoComplete="off" onChange={(e) => setMax(e.target.value)} />
            <span className="unit">USDG</span>
          </div>
          <div className="row2">
            <div>
              <div className="fl">
                <label htmlFor="of-open">Open spread</label>
              </div>
              <div className="inp sm">
                <input id="of-open" inputMode="decimal" value={open} autoComplete="off" onChange={(e) => setOpen(e.target.value)} />
                <span className="unit">bps</span>
              </div>
            </div>
            <div>
              <div className="fl">
                <label htmlFor="of-close">Close spread</label>
              </div>
              <div className="inp sm">
                <input id="of-close" inputMode="decimal" value={close} autoComplete="off" onChange={(e) => setClose(e.target.value)} />
                <span className="unit">bps</span>
              </div>
            </div>
          </div>
          <div className="fl">
            <span>Offer ends in</span>
          </div>
          <div className="seg full" role="group" aria-label="Offer ends in">
            {EXPIRIES.map((x) => (
              <button key={x} className={s.ofExp === x ? 'on' : ''} aria-pressed={s.ofExp === x} onClick={() => s.set({ ofExp: x })}>
                {x}
              </button>
            ))}
          </div>
          <div className="sumbox">
            <div>
              <span>You earn per $1,000 opened</span>
              <b>{usd(earnPer1000(v.open))}</b>
            </div>
            <div>
              <span>Takers pay to close</span>
              <b>{fmt(v.close, 0)} bps</b>
            </div>
            <div>
              <span>Backing locked</span>
              <b>{fmt(v.back)} USDG</b>
            </div>
            <div>
              <span>Most you can lose</span>
              <b>Your backing</b>
            </div>
          </div>
          <button className={`btn btn-block ${b.cls}`} disabled={b.disabled} onClick={b.onClick}>
            {b.label}
          </button>
          <p className="hint">{hint}</p>
          <p className="note">
            <I.info />
            <span>Your close spread is a promise. Takers can close against you at any time at the oracle price minus this spread, without your signature.</span>
          </p>
        </section>
        <div className="stack2">
          <section className="card">
            <h2 className="ph">Your offers</h2>
            <div style={{ marginTop: 8 }}>
              <Offers />
            </div>
          </section>
          <section className="card">
            <h2 className="ph">What others can see about you</h2>
            <div className="tbl-wrap" style={{ marginTop: 8 }}>
              <table className="tbl">
                <tbody>
                  <tr>
                    <td>Public chain</td>
                    <td className="muted">Not which maker backs a fill</td>
                  </tr>
                  <tr>
                    <td>Your takers</td>
                    <td className="muted">Not who you are</td>
                  </tr>
                  <tr>
                    <td>Coordinator</td>
                    <td className="muted">A one-time address and your offer terms</td>
                  </tr>
                  <tr>
                    <td>Risk service</td>
                    <td className="muted">A one-time address on each position</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="ph-sub" style={{ paddingBottom: 16 }}>
              Your spreads and how fast you quote can still hint at who you are in quiet markets.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
