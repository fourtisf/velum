'use client';
/**
 * Last-resort error page, used when the root layout itself throws (app/error.tsx cannot catch that
 * because it renders inside the layout). It replaces the whole document, so it brings its own
 * <html> and <body> and the global styles (audit web L6), and the brand line (final audit W-10).
 */
import { COPY } from '@/lib/copy';
import './globals.css';

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="wrap">
          <div className="empty" style={{ padding: '120px 20px' }}>
            <p style={{ fontSize: 17, color: 'var(--text)', fontWeight: 500 }}>Something went wrong.</p>
            <p>Your wallet and balances are not affected. Try again, or reload the page.</p>
            <button className="btn btn-white" onClick={reset}>
              Try again
            </button>
          </div>
          <p className="app-brand">{COPY.brand}</p>
        </main>
      </body>
    </html>
  );
}
