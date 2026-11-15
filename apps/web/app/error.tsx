'use client';
import { COPY } from '@/lib/copy';

/** Shown instead of a blank "Application error" when a page throws (audit web L3). */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="wrap">
      <div className="empty" style={{ padding: '120px 20px' }}>
        <p style={{ fontSize: 17, color: 'var(--text)', fontWeight: 500 }}>Something went wrong on this page.</p>
        <p>Your wallet and balances are not affected. Try again, or reload the page.</p>
        <button className="btn btn-white" onClick={reset}>
          Try again
        </button>
      </div>
      {/* CLAUDE.md §1.7: the brand line on every page (final audit W-10). */}
      <p className="app-brand">{COPY.brand}</p>
    </main>
  );
}
