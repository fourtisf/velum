import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { Providers } from '@/components/Providers';
import { LANDING, SOCIAL } from '@/lib/copy';
import './globals.css';

// Self-hosted (app/fonts, SIL OFL 1.1): the build never depends on fetching Google Fonts, and visitors never
// contact a third party for fonts. Same files and latin subset as next/font/google served before.
const inter = localFont({ src: './fonts/Inter-latin.woff2', weight: '400 600', variable: '--font-inter', display: 'swap' });
const interTight = localFont({ src: './fonts/InterTight-latin.woff2', weight: '500 600', variable: '--font-inter-tight', display: 'swap' });

const TITLE = 'Velum | Private Stock Token trading on Robinhood Chain';

export const metadata: Metadata = {
  title: TITLE,
  description: LANDING.metaDescription,
  metadataBase: process.env.PUBLIC_SITE_URL ? new URL(process.env.PUBLIC_SITE_URL) : undefined,
  // Robinhood Chain brand rules: "Stock Tokens" in full, in shared link previews too.
  openGraph: { title: TITLE, description: LANDING.metaDescription, siteName: 'Velum', type: 'website' },
  twitter: { card: 'summary', title: TITLE, description: LANDING.metaDescription, site: SOCIAL.xHandle, creator: SOCIAL.xHandle },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#08090B',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${interTight.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
