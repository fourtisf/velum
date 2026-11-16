'use client';
import { IS_MAINNET } from '@velum/config';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { privTotal } from '@/lib/calc';
import { shortH, usdBal } from '@/lib/format';
import { usePriceTick } from '@/lib/markets';
import { useOnchain } from '@/lib/onchain/deployment';
import { SOCIAL } from '@/lib/copy';
import { useApp } from '@/lib/store';
import { OcWalletTotal } from './onchain/lazy';
import { DemoBanner } from './DemoBanner';
import { I, Mark, XLogo } from './icons';

const TABS: Array<[string, string]> = [
  ['trade', 'Trade'],
  ['markets', 'Markets'],
  ['swap', 'Swap'],
  ['portfolio', 'Portfolio'],
  ['liquidity', 'Earn'],
  ['makers', 'Makers'],
];

export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="Velum home">
      <Mark />
      <span>Velum</span>
    </Link>
  );
}

export function EyeButton() {
  const veiled = useApp((s) => s.veiled);
  const set = useApp((s) => s.set);
  return (
    <button className="iconbtn" aria-pressed={veiled} aria-label="Hide balances on screen" title="Hide balances on screen" onClick={() => set({ veiled: !veiled })}>
      {veiled ? <I.eyeOff /> : <I.eye />}
    </button>
  );
}

/** Velum on X, in the nav of every page (owner request). */
export function XButton({ className = '' }: { className?: string }) {
  return (
    <a className={`iconbtn iconbtn-x ${className}`} href={SOCIAL.x} target="_blank" rel="noopener noreferrer" aria-label={SOCIAL.xLabel} title={`${SOCIAL.xHandle} on X`}>
      <XLogo />
    </a>
  );
}

function WalletTotal() {
  const oc = useOnchain();
  return oc ? <OcWalletTotal oc={oc} /> : <DemoWalletTotal />;
}

function DemoWalletTotal() {
  usePriceTick();
  const ledger = useApp((s) => s.ledger);
  return <span className="b num pv">{usdBal(privTotal(ledger))}</span>;
}

export function Nav({ variant }: { variant: 'landing' | 'app' }) {
  const app = variant === 'app';
  const path = usePathname() ?? '';
  const view = path.split('/')[2] ?? 'trade';
  const account = useApp((s) => s.account);
  const openModal = useApp((s) => s.openModal);
  const sel = useApp((s) => s.sel);
  const connected = !!account;

  return (
    <>
      <header className={app ? 'nav' : 'nav nav-land'}>
        <div className="nav-in">
          <Brand />
          {app ? (
            <nav className="nlinks tabs" aria-label="App">
              {TABS.map(([k, l]) => (
                <Link key={k} href={k === 'trade' ? `/app/trade/${sel}` : `/app/${k}`} className={view === k ? 'on' : ''} aria-current={view === k ? 'page' : undefined}>
                  {l}
                </Link>
              ))}
            </nav>
          ) : (
            <nav className="nlinks land" aria-label="Main">
              <a href="#features">Product</a>
              <a href="#how">How it works</a>
              <a href="#privacy">Privacy</a>
              <a href="#markets">Markets</a>
              <a href="#developers">Developers</a>
            </nav>
          )}
          <div className="nright">
            {/* In the app on a phone the nav keeps the wallet button; X stays in the brand line under the page. */}
            <XButton className={app ? 'hide-sm' : ''} />
            {app || connected ? <EyeButton /> : null}
            {connected ? (
              <button className="walletbtn" onClick={() => openModal({ kind: 'account' })}>
                <span className="sr">Your account</span>
                <i />
                <span className="hide-sm">{shortH(account.addr)}</span>
                {/* Mainnet: the real wallet address is never shown next to the simulated practice total (audit web F3). */}
                {IS_MAINNET ? null : <WalletTotal />}
              </button>
            ) : app ? (
              <button className="btn btn-white" onClick={() => openModal({ kind: 'connect' })}>
                Connect wallet
              </button>
            ) : (
              <button className="btn btn-ghost hide-sm" onClick={() => openModal({ kind: 'connect' })}>
                Connect wallet
              </button>
            )}
            {app ? null : (
              <Link className="btn btn-white" href="/app/trade/TSLA">
                Launch app
              </Link>
            )}
          </div>
        </div>
      </header>
      {/* Mainnet landing page while connected: the same demo note as in the app (audit web F3). */}
      {!app && connected && IS_MAINNET ? <DemoBanner /> : null}
    </>
  );
}
