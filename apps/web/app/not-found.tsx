import Link from 'next/link';
import { Nav } from '@/components/Nav';
import { COPY } from '@/lib/copy';

export default function NotFound() {
  return (
    <>
      <Nav variant="landing" />
      <main className="wrap">
        <div className="empty" style={{ padding: '120px 20px' }}>
          <p style={{ fontSize: 17, color: 'var(--text)', fontWeight: 500 }}>This page does not exist.</p>
          <p>Check the address, or go back to trading.</p>
          <Link className="btn btn-white" href="/app/trade/TSLA">
            Start trading
          </Link>
        </div>
        {/* CLAUDE.md §1.7: the brand line on every page (final audit W-10). */}
        <p className="app-brand">{COPY.brand}</p>
      </main>
    </>
  );
}
