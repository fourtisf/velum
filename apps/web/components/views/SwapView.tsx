'use client';
import { MARKETS, isLive } from '@velum/config';
import { amountHint, amountInputProps } from '@/lib/amount';
import { swapCalc } from '@/lib/calc';
import { CLOSED, SIM, UI } from '@/lib/copy';
import { doSwap } from '@/lib/demo';
import { dp, floorTo, fmt, fmtBal, sig4 } from '@/lib/format';
import { mk, usePriceTick } from '@/lib/markets';
import { useOnchain } from '@/lib/onchain/deployment';
import { bal, useApp } from '@/lib/store';
import { OcSwapView } from '../onchain/lazy';
import { I } from '../icons';

const TOKS = ['USDG', ...MARKETS.map((m) => m.symbol)];

function TokenSelect({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <select className="sel" id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {TOKS.map((t) => {
        const soon = t !== 'USDG' && !isLive(t);
        return (
          <option key={t} value={t} disabled={soon}>
            {soon ? `${t} (coming soon)` : t}
          </option>
        );
      })}
    </select>
  );
}

export function SwapView() {
  const oc = useOnchain();
  return oc ? <OcSwapView oc={oc} /> : <DemoSwapView />;
}

function DemoSwapView() {
  usePriceTick();
  const s = useApp();
  const connected = !!s.account;
  const { swapFrom: f, swapTo: t } = s;
  const c = swapCalc(f, t, s.swapAmt, s.slip, s.ledger.priv);
  const same = f === t;
  const bad = amountHint(s.swapAmt);
  let hint = bad;
  let btn: { label: string; cls: string; disabled: boolean; onClick?: () => void };
  if (!connected) btn = { label: 'Connect wallet', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'connect' }) };
  else if (same) btn = { label: 'Choose two different tokens', cls: 'btn-dark', disabled: true };
  else if (bad) btn = { label: 'Enter a valid amount', cls: 'btn-dark', disabled: true };
  else if (c.a <= 0n) btn = { label: 'Enter an amount', cls: 'btn-dark', disabled: true };
  else if (c.a > c.have) {
    btn = { label: `Not enough private ${f}`, cls: 'btn-dark', disabled: true };
    hint = `You have ${fmtBal(c.have, dp(f))} ${f} available.`;
  } else if (!c.priced) {
    // No live price for one side: no quote and no swap (audit round 2, M4).
    const closed = [f, t].some((x) => x !== 'USDG' && mk(x).sym === x && mk(x).closed);
    btn = { label: closed ? CLOSED.label : 'Price unavailable', cls: 'btn-dark', disabled: true };
    hint = closed ? CLOSED.hint : 'One of these tokens has no live price right now.';
  } else btn = { label: 'Swap privately', cls: 'btn-white', disabled: false, onClick: doSwap };
  const quoted = !same && c.priced;
  const [visK, visV] = SIM.visibleRow('The pool changed');

  return (
    <div className="swap-wrap">
      <div className="vhead">
        <div>
          <h1 className="vtitle">Swap privately</h1>
          <p className="vsub">{UI.swapSub}</p>
        </div>
      </div>
      <div className="card swapcard">
        <div className="sbox">
          <div className="lb">
            <span>You pay</span>
            <span>
              Available <b className="num pv">{connected ? `${fmtBal(c.have, dp(f))} ${f}` : '—'}</b>
            </span>
          </div>
          <div className="srow">
            <input id="sw-in" {...amountInputProps(s.swapAmt, 'sw-hint')} value={s.swapAmt} aria-label="Amount to pay" onChange={(e) => s.set({ swapAmt: e.target.value })} />
            <TokenSelect id="sw-from" label="Token to pay" value={f} onChange={(v) => s.set({ swapFrom: v })} />
          </div>
          <div className="seg full pcts" role="group" aria-label="Amount presets">
            {[25, 50, 100].map((p) => (
              <button key={p} onClick={() => s.set({ swapAmt: floorTo((bal(s.ledger.priv, f) * BigInt(p)) / 100n, dp(f)) })}>
                {p === 100 ? 'Max' : p + '%'}
              </button>
            ))}
          </div>
        </div>
        <button className="flipbtn" aria-label="Switch tokens" onClick={() => s.set({ swapFrom: t, swapTo: f })}>
          <I.flip />
        </button>
        <div className="sbox">
          <div className="lb">
            <span>You get (est.)</span>
            <span className="num">{same ? '' : `1 ${f} = ${c.priced ? sig4(c.rate) : '—'} ${t}`}</span>
          </div>
          <div className="srow">
            <output aria-label="You get (est.)">{!same && !c.priced ? '—' : same || c.out <= 0n ? '0.00' : sig4(c.out)}</output>
            <TokenSelect id="sw-to" label="Token to receive" value={t} onChange={(v) => s.set({ swapTo: v })} />
          </div>
        </div>
        <div className="sumbox" style={{ borderTop: 0, padding: '4px 4px 0' }}>
          <div>
            <span>Route</span>
            <b>
              <span className="route">
                {f}
                <I.chev />
                {c.hops === 2 ? (
                  <>
                    USDG
                    <I.chev />
                  </>
                ) : null}
                {t}
              </span>
            </b>
          </div>
          <div>
            <span>Pool fee{c.hops === 2 ? ' (2 pools)' : ''}</span>
            <b>{same || c.priced ? `${fmt(c.fee)} USDG` : '—'}</b>
          </div>
          <div>
            <span>Minimum you get</span>
            <b>{quoted ? `${sig4(c.min, 'floor')} ${t}` : '—'}</b>
          </div>
          <div>
            <span>{visK}</span>
            <b>{visV}</b>
          </div>
        </div>
        <button className={`btn btn-block ${btn.cls}`} disabled={btn.disabled} onClick={btn.onClick}>
          {btn.label}
        </button>
        <p className="hint" id="sw-hint">
          {hint}
        </p>
        <p className="note">
          <I.lock />
          <span>{UI.swapNote}</span>
        </p>
      </div>
    </div>
  );
}
