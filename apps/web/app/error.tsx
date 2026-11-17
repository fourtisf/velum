'use client';
import { useEffect } from 'react';
import { COPY } from '@/lib/copy';
import { reportError } from '@/lib/errorReport';

/** Shown instead of a blank "Application error" when a page throws (audit web L3); the error is reported (lib/errorReport.ts). */
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => reportError('boundary', error), [error]);
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
