'use client';
import { IS_MAINNET, TOKENS } from '@velum/config';
import type { Wad } from '@velum/math';
import { usePublicBalances } from '@/lib/balances';
import { inPos, privTotal, valueOf } from '@/lib/calc';
import { ACCT, SIM, UI } from '@/lib/copy';
import { fmt, fmtBal, shortH, usdBal } from '@/lib/format';
import { HL_PERPS } from '@/lib/hyperliquid/enabled';
import { useMarkets, usePriceTick } from '@/lib/markets';
import { useOnchain } from '@/lib/onchain/deployment';
import { bal, useApp } from '@/lib/store';
import { HlAccountRows } from '../hyperliquid/lazy';
import { OcAccountCard } from '../onchain/lazy';

export function AccountCard() {
  const oc = useOnchain();
  // Mainnet without Velum contracts: the wallet's real balances and the perps account, never a simulated balance.
  return oc ? <OcAccountCard oc={oc} /> : IS_MAINNET ? <LiveAccountCard /> : <DemoAccountCard />;
}

const STOCKS = Object.keys(TOKENS).filter((sym) => sym !== 'USDG');

function LiveAccountCard() {
  usePriceTick();
  useMarkets((m) => m.ethPx);
  const account = useApp((s) => s.account);
  const openModal = useApp((s) => s.openModal);
  const pub = usePublicBalances(account?.addr);
  if (!account)
    return (
      <aside className="card acct">
        <h2>{ACCT.title}</h2>
        <p className="muted" style={{ fontSize: 13.5, marginTop: 8 }}>
          {ACCT.connect}
        </p>
        <button className="btn btn-dark btn-sm" style={{ marginTop: 12 }} onClick={() => openModal({ kind: 'connect' })}>
          Connect wallet
        </button>
      </aside>
    );
  const b = pub.data?.bal;
  const usdg = b?.USDG ?? null;
  const held = b ? STOCKS.filter((sym) => (b[sym] ?? 0n) > 0n) : [];
  // Stock Tokens at the live price; any held token without a live price leaves the totals unknown (a dash).
  let stockValue: Wad | null = b ? 0n : null;
  for (const sym of held) {
    const v = valueOf(sym, b![sym]!);
    stockValue = v === null || stockValue === null ? null : stockValue + v;
  }
  // ETH at the live pool price (lib/uniswap/ethPrice.ts); the total counts it too, so it shows a dash until it is known.
  const ethValue = b?.ETH !== undefined ? valueOf('ETH', b.ETH) : null;
  const total = usdg !== null && stockValue !== null && (ethValue !== null || b?.ETH === 0n) ? usdg + stockValue + (ethValue ?? 0n) : null;
  const dash = pub.isError ? '—' : '…';
  return (
    <aside className="card acct">
      <h2>
        {ACCT.title}{' '}
        <span className="badge up" style={{ color: 'var(--up)' }}>
          <span className="d" />
          {ACCT.badge}
        </span>
      </h2>
      <div className="bigv num pv">{total !== null ? usdBal(total) : dash}</div>
      <div className="r">
        <span>USDG</span>
        <b className="num pv">{usdg !== null ? `${fmtBal(usdg)} USDG` : dash}</b>
      </div>
      <div className="r">
        <span>Stock Tokens{held.length ? ` (${held.join(', ')})` : ''}</span>
        <b className="num pv">{stockValue !== null ? usdBal(stockValue) : dash}</b>
      </div>
      <div className="r">
        <span>ETH</span>
        <b className="num pv">{b?.ETH !== undefined ? `${fmtBal(b.ETH, 4)} ETH${ethValue !== null ? ` · ${usdBal(ethValue)}` : ''}` : dash}</b>
      </div>
      {HL_PERPS ? <HlAccountRows /> : null}
      <div className="lastc">
        {ACCT.privateLabel}
        <b>{ACCT.privateState}</b>
        <span style={{ display: 'block', marginTop: 4, fontSize: 12 }}>{ACCT.privateNote}</span>
      </div>
    </aside>
  );
}

function DemoAccountCard() {
  usePriceTick();
  const s = useApp();
  if (!s.account)
    return (
      <aside className="card acct">
        <h2>Private account</h2>
        <p className="muted" style={{ fontSize: 13.5, marginTop: 8 }}>
          {UI.acctConnect}
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
      <div className="bigv num pv">{usdBal(privTotal(s.ledger))}</div>
      <div className="r">
        <span>Free balance</span>
        <b className="num pv">{fmtBal(bal(s.ledger.priv, 'USDG'))} USDG</b>
      </div>
      <div className="r">
        <span>In positions</span>
        <b className="num pv">{usdBal(inPos(s.ledger))}</b>
      </div>
      {SIM.chainView ? (
        <div className="lastc">
          {SIM.chainLastLabel}
          <b>{lc ? lc.what : 'Nothing yet'}</b>
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
