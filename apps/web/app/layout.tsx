import type { Metadata, Viewport } from 'next';
import { Inter, Inter_Tight } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers } from '@/components/Providers';
import { LANDING } from '@/lib/copy';
import './globals.css';

const inter = Inter({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-inter', display: 'swap' });
const interTight = Inter_Tight({ subsets: ['latin'], weight: ['500', '600'], variable: '--font-inter-tight', display: 'swap' });

const TITLE = 'Velum | Private Stock Token trading on Robinhood Chain';

export const metadata: Metadata = {
  title: TITLE,
  description: LANDING.metaDescription,
  metadataBase: process.env.PUBLIC_SITE_URL ? new URL(process.env.PUBLIC_SITE_URL) : undefined,
  // Robinhood Chain brand rules: "Stock Tokens" in full, in shared link previews too.
  openGraph: { title: TITLE, description: LANDING.metaDescription, siteName: 'Velum', type: 'website' },
  twitter: { card: 'summary', title: TITLE, description: LANDING.metaDescription },
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
