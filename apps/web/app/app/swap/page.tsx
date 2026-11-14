import type { Metadata } from 'next';
import { SwapView } from '@/components/views/SwapView';

export const metadata: Metadata = { title: 'Swap privately | Velum' };

export default function Page() {
  return <SwapView />;
}
