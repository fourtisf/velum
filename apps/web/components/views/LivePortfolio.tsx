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
import { useRouter } from 'next/navigation';
import { UNISWAP } from '@velum/config/src/uniswap';
import { valueOf } from '@/lib/calc';
import { costBasis, pnlOf, type Basis, type Pnl } from '@/lib/costBasis';
import { ACCT, COPY, LIVE } from '@/lib/copy';
import { ENV } from '@/lib/env';
import { ago, dp, fmt, fmtBal, sgnUsd, shortH, usd, usdBal, usdOrDash } from '@/lib/format';
import { HL_PERPS } from '@/lib/hyperliquid/enabled';
import { tokPx, useMarkets, usePriceTick } from '@/lib/markets';
import { unitsToInput, wadToUnits } from '@/lib/onchain/units';
import { bal, useApp } from '@/lib/store';
import { ACTIVITY_MAX, useWalletActivity, type Move, type WalletAct } from '@/lib/walletActivity';
import { useWalletTotals } from '@/lib/walletTotals';
import { HlAccountRows, HlPortfolioActivity, HlPortfolioPositions } from '../hyperliquid/lazy';
import { I } from '../icons';
import { Av, Px } from '../ui';

const DUST = 10n ** 11n; // 1e-7, the prototype's display threshold
const ORDER = ['ETH', 'WETH', 'USDG', 'TSLA', 'AMZN', 'PLTR', 'NVDA', 'NFLX', 'AMD', 'AAPL', 'META', 'MSFT', 'COIN'];
/** ETH here is Robinhood Chain's own ETH (its gas token), so the row says so; WETH is its wrapped form. */
const tokName = (t: string) => (t === 'USDG' ? 'Global Dollar' : t === 'ETH' ? 'ETH on Robinhood Chain' : t === 'WETH' ? 'Wrapped ETH on Robinhood Chain' : (getMarket(t)?.name ?? t));

/** "+$1.23 (+4.56%)" */
const pnlText = (p: Pnl) => `${sgnUsd(p.pnl)} (${p.bps >= 0 ? '+' : '-'}${(Math.abs(p.bps) / 100).toFixed(2)}%)`;

/** The P&L line under a Stock Token's value: known, still reading the trades, or not known (a dash, with why). */
function PnlLine({ pnl, state }: { pnl: Pnl | null; state: 'ok' | 'loading' | 'error' }) {
  if (pnl) return <small className={`pnl ${pnl.pnl >= 0n ? 'up' : 'down'}`}>{pnlText(pnl)}</small>;
  if (state === 'loading') return <small className="pnl faint">P&amp;L …</small>;
  return (
    <small className="pnl faint" title={LIVE.pnlUnknown}>
      P&amp;L —
    </small>
  );
}

function AssetRow({ t, amt, pnl, pnlState, onSell }: { t: string; amt: Wad; pnl?: Pnl | null; pnlState?: 'ok' | 'loading' | 'error'; onSell?: () => void }) {
  const stock = isMarketSymbol(t);
  return (
    <tr>
      <td>
        <div className="mcell">
          <Av sym={t} size="sm" />
          <div>
            <b>{t}</b>
            {/* On a phone the amount takes the name's place, so the value, P&L and Sell fit the screen. */}
            <small>
              <span className="hide-sm">{tokName(t)}</span>
              <span className="show-sm num">
                {fmtBal(amt, t === 'ETH' || t === 'WETH' ? 6 : dp(t))}
                {t === 'ETH' || t === 'WETH' ? ' · Robinhood' : ''}
              </span>
            </small>
          </div>
        </div>
      </td>
      <td className="r num hide-sm">{fmtBal(amt, t === 'ETH' || t === 'WETH' ? 6 : dp(t))}</td>
      {isMarketSymbol(t) ? <Px sym={t} as="td" className="r num hide-sm" /> : <td className="r num hide-sm">{usdOrDash(tokPx(t))}</td>}
      <td className="r num">
        {usdBal(valueOf(t, amt))}
        {stock ? <PnlLine pnl={pnl ?? null} state={pnlState ?? 'loading'} /> : null}
      </td>
      <td className="r">
        {onSell ? (
          <button className="btn btn-dark btn-sm" onClick={onSell} aria-label={`Sell ${t}`}>
            Sell
          </button>
        ) : null}
      </td>
    </tr>
  );
}

/** The wallet's ETH on Ethereum mainnet (the "ERC20" network, same address), or why it could not be read. */
function EthereumRow({ wei, error }: { wei: bigint | undefined; error: boolean }) {
  return (
    <tr>
      <td>
        <div className="mcell">
          <Av sym="ETH" size="sm" />
          <div>
            <b>ETH</b>
            <small>
              <span className={wei !== undefined ? 'hide-sm' : undefined}>{error && wei === undefined ? 'ETH on Ethereum: could not be read' : LIVE.l1Name}</span>
              {wei !== undefined ? <span className="show-sm num">{fmtBal(wei, 6)} · Ethereum</span> : null}
            </small>
          </div>
        </div>
      </td>
      <td className="r num hide-sm">{wei !== undefined ? fmtBal(wei, 6) : '—'}</td>
      <td className="r num hide-sm">{usdOrDash(tokPx('ETH'))}</td>
      <td className="r num">{wei !== undefined ? usdBal(valueOf('ETH', wei)) : '—'}</td>
      <td />
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
      <td className="r num hide-sm">—</td>
      <td className="r num hide-sm">—</td>
      <td className="r num">—</td>
      <td />
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
      {act.data.slice(0, ACTIVITY_MAX).map((a) => {
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
      <th className="r hide-sm">Amount</th>
      <th className="r hide-sm">Price</th>
      <th className="r">Value / P&amp;L</th>
      <th className="r">
        <span className="sr">Actions</span>
      </th>
    </tr>
  </thead>
);

/**
 * Everything the Portfolio shows, for the app page and the landing page's preview: balances on Robinhood Chain and
 * Ethereum, the rows to list, each Stock Token's P&L (cost basis from the wallet's own trades), the total stock P&L,
 * and Sell (the trade page's Spot ticket on Sell with the whole balance).
 */
export function usePortfolioData() {
  const s = useApp();
  const router = useRouter();
  const w = useWalletTotals(s.account?.addr);
  const { pub, rh: v, l1 } = w;
  const act = useWalletActivity(s.account?.addr);
  const basis: Record<string, Basis> = act.data ? costBasis(act.data) : {};
  const pnlState: 'ok' | 'loading' | 'error' = act.data ? 'ok' : act.isError ? 'error' : 'loading';
  const b = pub.data?.bal ?? {};
  const toks = ORDER.filter((t) => bal(b, t) > DUST);
  const gone = ORDER.filter((t) => pub.data?.unavailable.includes(t));
  // ETH on Ethereum: listed when held (or when it could not be read), right after Robinhood Chain's ETH.
  const l1Row = (l1.data !== undefined && l1.data > DUST) || (l1.isError && l1.data === undefined);
  const pnls = Object.fromEntries(v.held.map((t) => [t, pnlOf(basis[t], bal(b, t), valueOf(t, bal(b, t)))]));
  const known = v.held.filter((t) => pnls[t]);
  const stockPnl = known.reduce((sum, t) => sum + pnls[t]!.pnl, 0n);
  const stockCost = known.reduce((sum, t) => sum + pnls[t]!.cost, 0n);
  const sell = (t: string) => {
    const dec = UNISWAP?.decimals[t];
    const units = dec === undefined ? null : wadToUnits(bal(b, t) - (bal(b, t) % 10n ** BigInt(18 - dec)), dec);
    s.set({ spotSide: 'sell', spotAmt: units?.ok ? unitsToInput(units.units, dec!, dec!) : '1' });
    router.push(`/app/trade/${t}?mode=spot`);
  };
  const canSell = (t: string) => isMarketSymbol(t) && !!UNISWAP?.pools[t]?.length;
  const stockPnlTotal: Pnl | null = known.length ? { cost: stockCost, pnl: stockPnl, bps: stockCost > 0n ? Number((stockPnl * 10_000n) / stockCost) : 0 } : null;
  return { s, w, pub, v, l1, b, toks, gone, l1Row, pnls, known, stockPnlTotal, pnlState, sell, canSell };
}

/** The asset rows: Robinhood Chain tokens (ETH first), ETH on Ethereum after it, then any balance that could not be read. */
function AssetRows({ d, limit }: { d: ReturnType<typeof usePortfolioData>; limit?: number }) {
  const { toks, gone, l1Row, l1, b, pnls, pnlState, sell, canSell } = d;
  const rows = toks
    .map((t) => <AssetRow key={t} t={t} amt={bal(b, t)} pnl={pnls[t]} pnlState={pnlState} onSell={canSell(t) ? () => sell(t) : undefined} />)
    .flatMap((row, i) => (toks[i] === 'ETH' && l1Row ? [row, <EthereumRow key="eth-l1" wei={l1.data} error={l1.isError} />] : [row]));
  if (l1Row && !toks.includes('ETH')) rows.push(<EthereumRow key="eth-l1" wei={l1.data} error={l1.isError} />);
  rows.push(...gone.map((t) => <UnavailableRow key={t} t={t} />));
  // A preview lists Stock Tokens first (what P&L and Sell are about), then the rest.
  if (limit !== undefined) rows.sort((x, y) => Number(!isMarketSymbol(String(x.key))) - Number(!isMarketSymbol(String(y.key))));
  return <>{limit !== undefined ? rows.slice(0, limit) : rows}</>;
}

/** The landing page's live Portfolio preview (components/landing/Portfolio.tsx), once a wallet is connected. */
export function PortfolioPreview() {
  usePriceTick();
  useMarkets((m) => m.ethPx);
  const d = usePortfolioData();
  const { s, w, pub, v, toks, gone, l1Row, stockPnlTotal, pnlState } = d;
  if (!s.account) return null;
  const pending = pub.isError ? '—' : '…';
  const empty = !(toks.length || gone.length || l1Row);
  return (
    <div className="card lpf" style={{ marginTop: 40 }}>
      <div className="lpf-top">
        <div>
          <span className="muted" style={{ fontSize: 13.5 }}>
            {LIVE.valueLabel}{' '}
            <span className="badge up" style={{ color: 'var(--up)' }}>
              <span className="d" />
              {ACCT.badge}
            </span>
          </span>
          <div className="lpf-big num pv">{w.total !== null ? usdBal(w.total) : pending}</div>
        </div>
        {v.held.length ? (
          <div className="lpf-pnl">
            <span className="muted" style={{ fontSize: 13.5 }}>
              Stock P&amp;L
            </span>
            <b className={`num pv ${stockPnlTotal ? (stockPnlTotal.pnl >= 0n ? 'up' : 'down') : ''}`}>{stockPnlTotal ? pnlText(stockPnlTotal) : pnlState === 'loading' ? '…' : '—'}</b>
          </div>
        ) : null}
      </div>
      {empty ? (
        <div className="empty">
          <p>{pub.isLoading ? `Reading your wallet on ${COPY.chainLabel}…` : pub.isError ? `Could not reach ${COPY.chainLabel}. Retrying…` : LIVE.noAssets}</p>
        </div>
      ) : (
        <div className="tbl-wrap pf">
          <table className="tbl">
            {head}
            <tbody>
              <AssetRows d={d} limit={6} />
            </tbody>
          </table>
        </div>
      )}
      <div className="lpf-foot">
        <Link className="btn btn-white btn-sm" href={`/app/trade/${s.sel}?mode=spot`}>
          Buy Stock Tokens
        </Link>
        <Link className="btn btn-dark btn-sm" href="/app/portfolio">
          Open full Portfolio
        </Link>
      </div>
    </div>
  );
}

export function LivePortfolio() {
  usePriceTick();
  useMarkets((m) => m.ethPx);
  const d = usePortfolioData();
  const { s, w, pub, v, l1, b, toks, gone, l1Row, known, stockPnlTotal, pnlState } = d;

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
            <div className="pf-big num pv">{w.total !== null ? usdBal(w.total) : pending}</div>
            {w.l1Missing ? (
              <p className="faint" style={{ fontSize: 12.5, marginTop: 4 }}>
                {LIVE.l1Missing}
              </p>
            ) : null}
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
              <>
                <button className="btn btn-dark" onClick={() => s.openModal({ kind: 'hl-deposit' })}>
                  Deposit for perps
                </button>
                <button className="btn btn-dark" onClick={() => s.openModal({ kind: 'hl-withdraw' })}>
                  Withdraw from perps
                </button>
              </>
            ) : null}
          </div>
        </section>
        <div className="pf-grid">
          <section className="card">
            <h2 className="ph">{LIVE.assets}</h2>
            <p className="ph-sub">{LIVE.assetsSub}</p>
            {toks.length || gone.length || l1Row ? (
              <div className="tbl-wrap">
                <table className="tbl">
                  {head}
                  <tbody>
                    <AssetRows d={d} />
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
            {v.held.length ? (
              <div className="r">
                <span>
                  Stock P&amp;L{known.length && known.length < v.held.length ? ` (${known.length} of ${v.held.length})` : ''}
                </span>
                <b className={`num pv ${stockPnlTotal ? (stockPnlTotal.pnl >= 0n ? 'up' : 'down') : ''}`}>{stockPnlTotal ? pnlText(stockPnlTotal) : pnlState === 'loading' ? '…' : '—'}</b>
              </div>
            ) : null}
            <div className="r">
              <span>USDG</span>
              <b className="num pv">{v.usdg !== null ? usd(v.usdg) : pending}</b>
            </div>
            <div className="r">
              <span>ETH (Robinhood Chain){bal(b, 'WETH') > 0n ? ' + WETH' : ''}</span>
              <b className="num pv">{v.eth !== null ? usdBal(v.eth) : pending}</b>
            </div>
            <div className="r">
              <span>ETH (Ethereum)</span>
              <b className="num pv">{w.l1Value !== null ? usdBal(w.l1Value) : l1.isError ? '—' : '…'}</b>
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
              Open positions<span className="faint"> · perps</span>
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
