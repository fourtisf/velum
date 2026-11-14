'use client';
import { MARKETS, isLive } from '@velum/config';
import { swapCalc } from '@/lib/calc';
import { doSwap } from '@/lib/demo';
import { dp, floorTo, fmt, sig4 } from '@/lib/format';
import { useMarkets } from '@/lib/markets';
import { bal, useApp } from '@/lib/store';
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
  useMarkets((s) => s.tick);
  const s = useApp();
  const connected = !!s.account;
  const { swapFrom: f, swapTo: t } = s;
  const c = swapCalc(f, t, s.swapAmt, s.slip, s.ledger.priv);
  const same = f === t;
  let hint = '';
  let btn: { label: string; cls: string; disabled: boolean; onClick?: () => void };
  if (!connected) btn = { label: 'Connect wallet', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'connect' }) };
  else if (same) btn = { label: 'Choose two different tokens', cls: 'btn-dark', disabled: true };
  else if (c.a <= 0n) btn = { label: 'Enter an amount', cls: 'btn-dark', disabled: true };
  else if (c.a > c.have) {
    btn = { label: `Not enough private ${f}`, cls: 'btn-dark', disabled: true };
    hint = `You have ${fmt(c.have, dp(f))} ${f} available.`;
  } else btn = { label: 'Swap privately', cls: 'btn-white', disabled: false, onClick: doSwap };

  return (
    <div className="swap-wrap">
      <div className="vhead">
        <div>
          <h1 className="vtitle">Swap privately</h1>
          <p className="vsub">Trade USDG and stock tokens through private pools. Stock to stock routes through USDG in one action.</p>
        </div>
      </div>
      <div className="card swapcard">
        <div className="sbox">
          <div className="lb">
            <span>You pay</span>
            <span>
              Available <b className="num pv">{connected ? `${fmt(c.have, dp(f))} ${f}` : '—'}</b>
            </span>
          </div>
          <div className="srow">
            <input id="sw-in" inputMode="decimal" value={s.swapAmt} aria-label="Amount to pay" autoComplete="off" onChange={(e) => s.set({ swapAmt: e.target.value })} />
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
            <span className="num">{same ? '' : `1 ${f} = ${sig4(c.rate)} ${t}`}</span>
          </div>
          <div className="srow">
            <output aria-label="You get (est.)">{same || c.out <= 0n ? '0.00' : sig4(c.out)}</output>
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
            <b>{fmt(c.fee)} USDG</b>
          </div>
          <div>
            <span>Minimum you get</span>
            <b>{same ? '—' : `${sig4(c.min)} ${t}`}</b>
          </div>
          <div>
            <span>Visible onchain</span>
            <b>The pool changed</b>
          </div>
        </div>
        <button className={`btn btn-block ${btn.cls}`} disabled={btn.disabled} onClick={btn.onClick}>
          {btn.label}
        </button>
        <p className="hint">{hint}</p>
        <p className="note">
          <I.lock />
          <span>Pool reserves are private, so nobody can work out your trade from public data.</span>
        </p>
      </div>
    </div>
  );
}
