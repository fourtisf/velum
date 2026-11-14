import type { ReactNode } from 'react';
import { DemoBanner } from '@/components/DemoBanner';
import { Nav } from '@/components/Nav';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="in-app">
      <Nav variant="app" />
      <DemoBanner />
      <main className="app-main">
        <div className="appw">{children}</div>
      </main>
    </div>
  );
}
