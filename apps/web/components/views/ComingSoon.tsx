'use client';
import Link from 'next/link';
import { useApp } from '@/lib/store';

/**
 * A page that needs Velum's own contracts, on mainnet before they launch (WALLET_ONLY): a plain note and the real
 * things to do instead. Nothing simulated.
 */
export function ComingSoon({ title, text }: { title: string; text: string }) {
  const sel = useApp((s) => s.sel);
  return (
    <>
      <div className="vhead">
        <div>
          <h1 className="vtitle">{title}</h1>
        </div>
      </div>
      <div className="card empty" style={{ padding: '72px 20px' }}>
        <p style={{ fontSize: 17, color: 'var(--text)', fontWeight: 500 }}>Coming with Velum&apos;s own contracts</p>
        <p>{text}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link className="btn btn-white" href={`/app/trade/${sel}`}>
            Trade
          </Link>
          <Link className="btn btn-dark" href="/app/portfolio">
            Portfolio
          </Link>
        </div>
      </div>
    </>
  );
}
