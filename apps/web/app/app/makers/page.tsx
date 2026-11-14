import type { Metadata } from 'next';
import { MakersView } from '@/components/views/MakersView';

export const metadata: Metadata = { title: 'Maker desk | Velum' };

export default function Page() {
  return <MakersView />;
}
