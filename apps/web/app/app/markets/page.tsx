import type { Metadata } from 'next';
import { MarketsView } from '@/components/views/MarketsView';

export const metadata: Metadata = { title: 'Markets | Velum' };

export default function Page() {
  return <MarketsView />;
}
