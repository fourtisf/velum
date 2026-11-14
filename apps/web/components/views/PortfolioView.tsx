'use client';
import { CHAIN, IS_MAINNET, getMarket, isMarketSymbol } from '@velum/config';
import type { Wad } from '@velum/math';
import Link from 'next/link';
import { privTotal, valueOf } from '@/lib/calc';
import { dp, fmt, usd } from '@/lib/format';
import { usePublicBalances } from '@/lib/balances';
import { tokPx, useMarkets } from '@/lib/markets';
import { bal, useApp } from '@/lib/store';
import { COPY } from '@/lib/copy';
import { I } from '../icons';
import { ActList, PosTable } from '../trade/Positions';
import { Av, Pv, Px } from '../ui';

const DUST = 10n ** 11n; // 1e-7, the prototype's display threshold
const tokName = (t: string) => (t === 'USDG' ? 'Global Dollar' : t === 'ETH' ? 'Gas token' : (getMarket(t)?.name ?? t));
const ORDER = ['ETH', 'USDG', 'TSLA', 'AMZN', 'PLTR', 'NVDA', 'NFLX', 'AMD', 'AAPL', 'META', 'MSFT', 'COIN'];

function AssetRow({ t, amt, pub }: { t: string; amt: Wad; pub?: boolean }) {
  const unpriced = IS_MAINNET && t === 'ETH';
  const v = unpriced ? '—' : usd(valueOf(t, amt));
  return (
    <tr>
      <td>
        <div className="mcell">
          <Av sym={t} size="sm" />
          <div>
            <b>{t}</b>
            <small>{tokName(t)}</small>
          </div>
        </div>
      </td>
      <td className="r num">{pub ? fmt(amt, dp(t)) : <Pv>{fmt(amt, dp(t))}</Pv>}</td>
      {isMarketSymbol(t) ? <Px sym={t} as="td" className="r num hide-sm" /> : <td className="r num hide-sm">{unpriced ? '—' : usd(tokPx(t))}</td>}
      <td className="r num">{pub ? v : <Pv>{v}</Pv>}</td>
    </tr>
  );
}

function Faucets() {
  return (
    <>
      Get ETH and stock tokens from the{' '}
      <a className="lnk" href={CHAIN.faucets.ethAndStockTokens} target="_blank" rel="noreferrer">
        Robinhood Chain faucet
      </a>{' '}
      and USDG from the{' '}
      <a className="lnk" href={CHAIN.faucets.usdg} target="_blank" rel="noreferrer">
        Paxos faucet
      </a>
      .
    </>
  );
}

const head = (
  <thead>
    <tr>
      <th>Asset</th>
      <th className="r">Amount</th>
      <th className="r hide-sm">Price</th>
      <th className="r">Value</th>
    </tr>
  </thead>
);

export function PortfolioView() {
  useMarkets((s) => s.tick);
  const s = useApp();
  const pub = usePublicBalances(s.account?.addr);

  if (!s.account)
    return (
      <>
        <div className="vhead">
          <div>
            <h1 className="vtitle">Portfolio</h1>
          </div>
        </div>
        <div className="card empty" style={{ padding: '72px 20px' }}>
          <p style={{ fontSize: 17, color: 'var(--text)', fontWeight: 500 }}>Connect your wallet to open your private account.</p>
          <p>One signature creates your private keys in this browser. It costs no gas, and the same wallet opens the same account on any device.</p>
          <button className="btn btn-white btn-lg" onClick={() => s.openModal({ kind: 'connect' })}>
            Connect wallet
          </button>
          {CHAIN.faucets.usdg ? (
            <p className="faucets">
              New to testnet? <Faucets />
            </p>
          ) : null}
        </div>
      </>
    );

  const { ledger, account } = s;
  const priv = ORDER.filter((t) => bal(ledger.priv, t) > DUST);
  const pubToks = ORDER.filter((t) => bal(pub.data ?? {}, t) > DUST);
  const copy = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(account.paddr).catch(() => undefined);
    s.toast('Private address copied');
  };
  return (
    <>
      <div className="vhead">
        <div>
          <h1 className="vtitle">Portfolio</h1>
          <p className="vsub">Everything below is decrypted on this device only.</p>
        </div>
      </div>
      <div className="pf">
        <section className="card pf-hero">
          <div>
            <span className="muted" style={{ fontSize: 13.5 }}>
              Private balance
            </span>
            <div className="pf-big num pv">{usd(privTotal(ledger))}</div>
            <div className="pf-sub">
              <span className="paddr">
                <Pv>{account.paddr.slice(0, 12) + '…' + account.paddr.slice(-6)}</Pv>
                <button className="icb" aria-label="Copy private address" onClick={copy}>
                  <I.copy />
                </button>
              </span>
              <span>Share this address to receive private transfers.</span>
            </div>
          </div>
          <div className="pf-actions">
            <button className="btn btn-white" onClick={() => s.openModal({ kind: 'move', move: 'shield' })}>
              Shield
            </button>
            <button className="btn btn-dark" onClick={() => s.openModal({ kind: 'move', move: 'unshield' })}>
              Unshield
            </button>
            <button className="btn btn-dark" onClick={() => s.openModal({ kind: 'move', move: 'send' })}>
              Send privately
            </button>
          </div>
        </section>
        <div className="pf-grid">
          <section className="card">
            <h2 className="ph">Private assets</h2>
            <p className="ph-sub">Free balance you can trade, send or unshield.</p>
            <div className="tbl-wrap">
              <table className="tbl">
                {head}
                <tbody>
                  {priv.length ? (
                    priv.map((t) => <AssetRow key={t} t={t} amt={bal(ledger.priv, t)} />)
                  ) : (
                    <tr>
                      <td colSpan={4} className="empty">
                        Nothing here yet. Shield tokens to start.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card">
            <h2 className="ph">Public wallet</h2>
            <p className="ph-sub">Anyone can see this. Shield tokens to make them private.</p>
            <div className="tbl-wrap">
              <table className="tbl">
                {head}
                <tbody>
                  {pubToks.length ? (
                    pubToks.map((t) => <AssetRow key={t} t={t} amt={bal(pub.data ?? {}, t)} pub />)
                  ) : (
                    <tr>
                      <td colSpan={4} className="empty">
                        {pub.isLoading ? (
                          `Reading your wallet on ${COPY.chainLabel}…`
                        ) : pub.isError ? (
                          `Could not reach ${COPY.chainLabel}. Retrying…`
                        ) : (
                          <span>{CHAIN.faucets.usdg ? (
                            <>
                              No test tokens yet. <Faucets />
                            </>
                          ) : (
                            'No USDG or supported stock tokens in this wallet yet.'
                          )}</span>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <section className="card">
          <h2 className="ph">Open positions</h2>
          {ledger.positions.length ? (
            <div style={{ marginTop: 8 }}>
              <PosTable list={ledger.positions} wide />
            </div>
          ) : (
            <div className="empty">
              <p>No open positions.</p>
              <Link className="btn btn-dark btn-sm" href={`/app/trade/${s.sel}?mode=perps`}>
                Open a position
              </Link>
            </div>
          )}
        </section>
        <section className="card">
          <h2 className="ph">Activity</h2>
          <div style={{ marginTop: 8 }}>
            <ActList list={ledger.history} n={12} />
          </div>
        </section>
      </div>
    </>
  );
}
