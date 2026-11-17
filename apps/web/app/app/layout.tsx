import type { ReactNode } from 'react';
import { DemoBanner } from '@/components/DemoBanner';
import { TgLogo, XLogo } from '@/components/icons';
import { Nav } from '@/components/Nav';
import { COPY, SOCIAL } from '@/lib/copy';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="in-app">
      <Nav variant="app" />
      <DemoBanner />
      <main className="app-main">
        <div className="appw">{children}</div>
        {/* CLAUDE.md §1.7: the brand line on every page, small (audit web F11). */}
        <p className="app-brand">
          {COPY.brand}
          <a className="brand-x" href={SOCIAL.x} target="_blank" rel="noopener noreferrer" aria-label={SOCIAL.xLabel}>
            <XLogo />
          </a>
          <a className="brand-x" href={SOCIAL.tg} target="_blank" rel="noopener noreferrer" aria-label={SOCIAL.tgLabel}>
            <TgLogo />
          </a>
        </p>
      </main>
    </div>
  );
}
