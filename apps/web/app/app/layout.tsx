import type { ReactNode } from 'react';
import { DemoBanner } from '@/components/DemoBanner';
import { Nav } from '@/components/Nav';
import { COPY } from '@/lib/copy';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="in-app">
      <Nav variant="app" />
      <DemoBanner />
      <main className="app-main">
        <div className="appw">{children}</div>
        {/* CLAUDE.md §1.7: the brand line on every page, small (audit web F11). */}
        <p className="app-brand">{COPY.brand}</p>
      </main>
    </div>
  );
}
