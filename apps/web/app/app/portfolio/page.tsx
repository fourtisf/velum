import type { Metadata } from 'next';
import { PortfolioView } from '@/components/views/PortfolioView';

export const metadata: Metadata = { title: 'Portfolio | Velum' };

export default function Page() {
  return <PortfolioView />;
}
