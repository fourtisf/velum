import type { Metadata } from 'next';
import { LegalPage } from '@/components/Legal';
import { TERMS } from '@/lib/legal';

export const metadata: Metadata = { title: 'Terms of Use · Velum', description: 'The terms for using Velum, an independent interface for Stock Tokens and perps on Robinhood Chain.' };

export default function Terms() {
  return <LegalPage title="Terms of Use" lead="Please read these terms before using Velum. By using it you agree to them." sections={TERMS} other={{ href: '/risk', label: 'Risk Disclosure' }} />;
}
