import type { Metadata } from 'next';
import { LegalPage } from '@/components/Legal';
import { RISKS } from '@/lib/legal';

export const metadata: Metadata = { title: 'Risk Disclosure · Velum', description: 'The risks of trading Stock Tokens and leveraged perps through Velum.' };

export default function Risk() {
  return <LegalPage title="Risk Disclosure" lead="Trading Stock Tokens and perps is risky. Only trade what you can afford to lose." sections={RISKS} other={{ href: '/terms', label: 'Terms of Use' }} />;
}
