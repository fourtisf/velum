'use client';
/**
 * The landing page's Portfolio section (Robinhood Chain mainnet without Velum contracts, WALLET_ONLY): what the
 * Portfolio does, and once a wallet is connected, its live preview (wallet value, Stock Tokens with P&L and Sell),
 * loaded on demand so the landing page stays light. Nothing simulated: no sample balances.
 */
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { LIVE } from '@/lib/copy';
import { WALLET_ONLY } from '@/lib/onchain/deployment';
import { useApp } from '@/lib/store';

const Preview = dynamic(() => import('../views/LivePortfolio').then((m) => m.PortfolioPreview), {
  ssr: false,
  loading: () => <div className="card lpf" aria-busy="true" style={{ marginTop: 40, minHeight: 260 }} />,
});

const POINTS: Array<[string, string]> = [
  ['Live value', 'Every Stock Token, USDG and ETH in your wallet at live prices, on Robinhood Chain and Ethereum.'],
  ['P&L from the chain', 'What each holding cost, read from your own trades on Robinhood Chain, against its price now.'],
  ['Sell in one tap', 'Sell opens the ticket with your whole balance filled in. One Uniswap swap, straight from your wallet.'],
];

export function LandingPortfolio() {
  const connected = useApp((s) => s.account !== null);
  const openModal = useApp((s) => s.openModal);
  if (!WALLET_ONLY) return null;
  return (
    <section className="sec" id="portfolio">
      <div className="sec-top">
        <div>
          <span className="eyebrow">Portfolio</span>
          <h2>Your stocks, your P&amp;L, one-tap Sell.</h2>
          <p className="lead">{LIVE.landingLead}</p>
        </div>
        <Link className="btn btn-dark" href="/app/portfolio">
          Open Portfolio
        </Link>
      </div>
      {connected ? (
        <Preview />
      ) : (
        <div className="card lpf" style={{ marginTop: 40 }}>
          <div className="lpf-points">
            {POINTS.map(([t, d]) => (
              <div key={t}>
                <b>{t}</b>
                <p>{d}</p>
              </div>
            ))}
          </div>
          <div className="lpf-foot">
            <button className="btn btn-white btn-sm" onClick={() => openModal({ kind: 'connect' })}>
              Connect wallet to see yours
            </button>
            <span className="muted" style={{ fontSize: 13 }}>
              {LIVE.landingNote}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
