'use client';
/**
 * The Portfolio on Robinhood Chain mainnet before Velum's own contracts launch (WALLET_ONLY): only real things. The
 * wallet's balances at live prices (ETH at the WETH/USDG pool price), its recent trades and transfers read from the
 * chain (lib/walletActivity.ts), and the user's own Hyperliquid perps account (balance, open positions, fills). No
 * simulated balance, private address, Shield/Unshield or demo history.
 */
import { getMarket, isMarketSymbol } from '@velum/config';
import type { Wad } from '@velum/math';
import Link from 'next/link';
import { usePublicBalances } from '@/lib/balances';
import { valueOf } from '@/lib/calc';
import { ACCT, COPY, LIVE } from '@/lib/copy';
import { ENV } from '@/lib/env';
import { ago, dp, fmt, fmtBal, shortH, usd, usdBal, usdOrDash } from '@/lib/format';
import { HL_PERPS } from '@/lib/hyperliquid/enabled';
import { tokPx, useMarkets, usePriceTick } from '@/lib/markets';
import { bal, useApp } from '@/lib/store';
import { useWalletActivity, type Move, type WalletAct } from '@/lib/walletActivity';
import { walletValue } from '@/lib/walletValue';
import { HlAccountRows, HlPortfolioActivity, HlPortfolioPositions } from '../hyperliquid/lazy';
import { I } from '../icons';
import { Av, Px } from '../ui';

const DUST = 10n ** 11n; // 1e-7, the prototype's display threshold
const ORDER = ['ETH', 'WETH', 'USDG', 'TSLA', 'AMZN', 'PLTR', 'NVDA', 'NFLX', 'AMD', 'AAPL', 'META', 'MSFT', 'COIN'];
/** ETH here is Robinhood Chain's own ETH (its gas token), so the row says so; WETH is its wrapped form. */
const tokName = (t: string) => (t === 'USDG' ? 'Global Dollar' : t === 'ETH' ? 'ETH on Robinhood Chain' : t === 'WETH' ? 'Wrapped ETH on Robinhood Chain' : (getMarket(t)?.name ?? t));

function AssetRow({ t, amt }: { t: string; amt: Wad }) {
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
      <td className="r num">{fmtBal(amt, t === 'ETH' || t === 'WETH' ? 6 : dp(t))}</td>
      {isMarketSymbol(t) ? <Px sym={t} as="td" className="r num hide-sm" /> : <td className="r num hide-sm">{usdOrDash(tokPx(t))}</td>}
      <td className="r num">{usdBal(valueOf(t, amt))}</td>
    </tr>
  );
}

function UnavailableRow({ t }: { t: string }) {
  return (
    <tr>
      <td>
        <div className="mcell">
          <Av sym={t} size="sm" />
          <div>
            <b>{t}</b>
            <small>Balance could not be read</small>
          </div>
        </div>
      </td>
      <td className="r num">—</td>
      <td className="r num hide-sm">—</td>
      <td className="r num">—</td>
    </tr>
  );
}

/** "0.0512 NVDA" from base units. */
const moveText = (m: Move) => `${fmt(m.units * 10n ** BigInt(18 - m.decimals), m.sym === 'USDG' ? 2 : 4)} ${m.sym}`;
const ethText = (wei: bigint) => `${fmt(wei, 6)} ETH`;

/** One line per transaction: what happened, what was paid or received, when, and a link to it on the explorer. */
function actLine(a: WalletAct): { title: string; sub: string; icon: 'trade' | 'swapI' | 'send' | 'drop' } {
  const ins = a.in.map(moveText).join(' + ');
  const outs = a.out.map(moveText).join(' + ');
  switch (a.kind) {
    case 'buy':
      return { title: `Bought ${ins}`, sub: a.ethPaid > 0n ? `Paid ${ethText(a.ethPaid)} · Uniswap` : `Paid ${outs} · Uniswap`, icon: 'trade' };
    case 'sell':
      return { title: `Sold ${outs}`, sub: `Got ${ins} · Uniswap`, icon: 'trade' };
    case 'swap':
      return { title: `Swapped ${outs}`, sub: `For ${ins}`, icon: 'swapI' };
    case 'send':
      return { title: `Sent ${outs}`, sub: a.counterparty ? `To ${shortH(a.counterparty)}` : 'Transfer', icon: 'send' };
    default:
      return { title: `Received ${ins}`, sub: a.counterparty ? `From ${shortH(a.counterparty)}` : 'Transfer', icon: 'drop' };
  }
}

function WalletActivity({ addr }: { addr: `0x${string}` }) {
  const act = useWalletActivity(addr);
  if (act.isError && !act.data)
    return (
      <div className="empty">
        <p>{LIVE.activityDown}</p>
      </div>
    );
  if (!act.data)
    return (
      <div className="empty" aria-busy="true">
        <p>Reading your activity on {COPY.chainLabel}…</p>
      </div>
    );
  if (!act.data.length)
    return (
      <div className="empty">
        <p>{LIVE.noActivity}</p>
      </div>
    );
  return (
    <>
      {act.data.map((a) => {
        const l = actLine(a);
        const Icon = I[l.icon];
        return (
          <div className="act" key={a.hash}>
            <span className="ic">
              <Icon />
            </span>
            <div>
              <b className="pv">{l.title}</b>
              <small>
                {l.sub} ·{' '}
                <a className="lnk" href={`${ENV.explorerUrl}/tx/${a.hash}`} target="_blank" rel="noreferrer">
                  View transaction
                </a>
              </small>
            </div>
            <small className="faint" suppressHydrationWarning>
              {a.time ? ago(a.time) : ''}
            </small>
          </div>
        );
      })}
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

export function LivePortfolio() {
  usePriceTick();
  useMarkets((m) => m.ethPx);
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
          <p style={{ fontSize: 17, color: 'var(--text)', fontWeight: 500 }}>Connect your wallet to see your portfolio.</p>
          <p>{ACCT.connect}</p>
          <button className="btn btn-white btn-lg" onClick={() => s.openModal({ kind: 'connect' })}>
            Connect wallet
          </button>
        </div>
      </>
    );

  const addr = s.account.addr;
  const b = pub.data?.bal ?? {};
  const v = walletValue(pub.data?.bal, pub.data?.unavailable);
  const toks = ORDER.filter((t) => bal(b, t) > DUST);
  const gone = ORDER.filter((t) => pub.data?.unavailable.includes(t));
  const copy = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(addr).catch(() => undefined);
    s.toast('Wallet address copied');
  };
  const pending = pub.isError ? '—' : '…';
  return (
    <>
      <div className="vhead">
        <div>
          <h1 className="vtitle">Portfolio</h1>
          <p className="vsub">{LIVE.portfolioSub}</p>
        </div>
      </div>
      <div className="pf">
        <section className="card pf-hero">
          <div>
            <span className="muted" style={{ fontSize: 13.5 }}>
              {LIVE.valueLabel}{' '}
              <span className="badge up" style={{ color: 'var(--up)' }}>
                <span className="d" />
                {ACCT.badge}
              </span>
            </span>
            <div className="pf-big num pv">{v.total !== null ? usdBal(v.total) : pending}</div>
            <div className="pf-sub">
              <span className="paddr">
                {shortH(addr)}
                <button className="icb" aria-label="Copy wallet address" onClick={copy}>
                  <I.copy />
                </button>
              </span>
              <a className="lnk" href={`${ENV.explorerUrl}/address/${addr}`} target="_blank" rel="noreferrer">
                View on explorer
              </a>
              <span>{LIVE.valueNote}</span>
            </div>
          </div>
          <div className="pf-actions">
            <Link className="btn btn-white" href={`/app/trade/${s.sel}?mode=spot`}>
              Buy Stock Tokens
            </Link>
            <Link className="btn btn-dark" href="/app/swap">
              Swap
            </Link>
            {HL_PERPS ? (
              <button className="btn btn-dark" onClick={() => s.openModal({ kind: 'hl-deposit' })}>
                Deposit for perps
              </button>
            ) : null}
          </div>
        </section>
        <div className="pf-grid">
          <section className="card">
            <h2 className="ph">{LIVE.assets}</h2>
            <p className="ph-sub">{LIVE.assetsSub}</p>
            {toks.length || gone.length ? (
              <div className="tbl-wrap">
                <table className="tbl">
                  {head}
                  <tbody>
                    {toks.map((t) => (
                      <AssetRow key={t} t={t} amt={bal(b, t)} />
                    ))}
                    {gone.map((t) => (
                      <UnavailableRow key={t} t={t} />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              // Outside the table, so the message wraps on a phone.
              <div className="empty">
                <p>{pub.isLoading ? `Reading your wallet on ${COPY.chainLabel}…` : pub.isError ? `Could not reach ${COPY.chainLabel}. Retrying…` : LIVE.noAssets}</p>
              </div>
            )}
          </section>
          <section className="card acct">
            <h2>{ACCT.title}</h2>
            <div className="r">
              <span>Stock Tokens{v.held.length ? ` (${v.held.join(', ')})` : ''}</span>
              <b className="num pv">{v.stocks !== null ? usdBal(v.stocks) : pending}</b>
            </div>
            <div className="r">
              <span>USDG</span>
              <b className="num pv">{v.usdg !== null ? usd(v.usdg) : pending}</b>
            </div>
            <div className="r">
              <span>ETH (Robinhood Chain){bal(b, 'WETH') > 0n ? ' + WETH' : ''}</span>
              <b className="num pv">{v.eth !== null ? usdBal(v.eth) : pending}</b>
            </div>
            {HL_PERPS ? <HlAccountRows /> : null}
            <div className="lastc">
              {ACCT.privateLabel}
              <b>{ACCT.privateState}</b>
              <span style={{ display: 'block', marginTop: 4, fontSize: 12 }}>{ACCT.privateNote}</span>
            </div>
          </section>
        </div>
        {HL_PERPS ? (
          <section className="card">
            <h2 className="ph">
              Open positions<span className="faint"> on Hyperliquid</span>
            </h2>
            <div style={{ marginTop: 8 }}>
              <HlPortfolioPositions />
            </div>
          </section>
        ) : null}
        <section className="card">
          <h2 className="ph">{LIVE.activity}</h2>
          <p className="ph-sub">{LIVE.activitySub}</p>
          <div style={{ marginTop: 8 }}>
            <WalletActivity addr={addr} />
          </div>
        </section>
        {HL_PERPS ? (
          <section className="card">
            <h2 className="ph">
              {LIVE.perpsActivity}
              <span className="faint"> on Hyperliquid</span>
            </h2>
            <div style={{ marginTop: 8 }}>
              <HlPortfolioActivity />
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
