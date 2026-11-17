import Link from 'next/link';
import { Nav } from '@/components/Nav';
import { COPY } from '@/lib/copy';
import { LEGAL_UPDATED, type LegalSection } from '@/lib/legal';

/** A legal page (Terms, Risk Disclosure) in the site's frame. */
export function LegalPage({ title, lead, sections, other }: { title: string; lead: string; sections: LegalSection[]; other: { href: string; label: string } }) {
  return (
    <>
      <Nav variant="landing" />
      <main className="wrap legal">
        <h1>{title}</h1>
        <p className="legal-lead">{lead}</p>
        {sections.map((s) => (
          <section key={s.h}>
            <h2>{s.h}</h2>
            {s.p.map((t, i) => (
              <p key={i}>{t}</p>
            ))}
          </section>
        ))}
        <p className="legal-foot">
          Last updated {LEGAL_UPDATED}. See also the <Link href={other.href}>{other.label}</Link>.
        </p>
        <p className="legal-foot">
          Country lookup for the perps region check:{' '}
          <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">
            IP Geolocation by DB-IP
          </a>{' '}
          (CC BY 4.0).
        </p>
        <p className="app-brand">{COPY.brand}</p>
      </main>
    </>
  );
}
