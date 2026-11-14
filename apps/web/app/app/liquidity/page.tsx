import type { Metadata } from 'next';
import { LiquidityView } from '@/components/views/LiquidityView';

export const metadata: Metadata = { title: 'Earn | Velum' };

export default function Page() {
  return <LiquidityView />;
}
