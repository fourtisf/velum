'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { privTotal } from '@/lib/calc';
import { shortH, usd } from '@/lib/format';
import { useMarkets } from '@/lib/markets';
import { useApp } from '@/lib/store';
import { I, Mark } from './icons';

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

function WalletTotal() {
  useMarkets((s) => s.tick);
  const ledger = useApp((s) => s.ledger);
  return <span className="b num pv">{usd(privTotal(ledger))}</span>;
}

export function Nav({ variant }: { variant: 'landing' | 'app' }) {
  const app = variant === 'app';
  const path = usePathname() ?? '';
  const view = path.split('/')[2] ?? 'trade';
  const account = useApp((s) => s.account);
  const openModal = useApp((s) => s.openModal);
  const connected = !!account;

  return (
    <header className="nav">
      <div className="nav-in">
        <Brand />
        {app ? (
          <nav className="nlinks tabs" aria-label="App">
            {TABS.map(([k, l]) => (
              <Link key={k} href={k === 'trade' ? '/app/trade/TSLA' : `/app/${k}`} className={view === k ? 'on' : ''} aria-current={view === k ? 'page' : undefined}>
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
          {app || connected ? <EyeButton /> : null}
          {connected ? (
            <button className="walletbtn" onClick={() => openModal({ kind: 'account' })}>
              <i />
              <span className="hide-sm">{shortH(account.addr)}</span>
              <WalletTotal />
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
  );
}
