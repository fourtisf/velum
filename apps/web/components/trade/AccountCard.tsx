'use client';
import { inPos, privTotal } from '@/lib/calc';
import { SIM } from '@/lib/copy';
import { fmt, shortH, usdOrDash } from '@/lib/format';
import { usePriceTick } from '@/lib/markets';
import { bal, useApp } from '@/lib/store';

export function AccountCard() {
  usePriceTick();
  const s = useApp();
  if (!s.account)
    return (
      <aside className="card acct">
        <h2>Private account</h2>
        <p className="muted" style={{ fontSize: 13.5, marginTop: 8 }}>
          Connect a wallet and sign once to open a private balance. It costs no gas.
        </p>
        <button className="btn btn-dark btn-sm" style={{ marginTop: 12 }} onClick={() => s.openModal({ kind: 'connect' })}>
          Connect wallet
        </button>
      </aside>
    );
  const lc = s.ledger.lastChain;
  return (
    <aside className="card acct">
      <h2>
        Private account{' '}
        <span className="badge acc">
          <span className="d" />
          {SIM.accountBadge}
        </span>
      </h2>
      <div className="bigv num pv">{usdOrDash(privTotal(s.ledger))}</div>
      <div className="r">
        <span>Free balance</span>
        <b className="num pv">{fmt(bal(s.ledger.priv, 'USDG'))} USDG</b>
      </div>
      <div className="r">
        <span>In positions</span>
        <b className="num pv">{usdOrDash(inPos(s.ledger))}</b>
      </div>
      {SIM.chainView ? (
        <div className="lastc">
          Last thing the public chain saw<b>{lc ? lc.what : 'Nothing yet'}</b>
          {lc ? (
            <code>
              {shortH(lc.commit)}, block {fmt(lc.block, 0)}
            </code>
          ) : null}
        </div>
      ) : (
        // Mainnet: no Velum contract exists, so there is no commitment or block to show (audit round 2, M2).
        <div className="lastc">
          Public chain<b>{SIM.nothingOnchain}</b>
        </div>
      )}
    </aside>
  );
}
