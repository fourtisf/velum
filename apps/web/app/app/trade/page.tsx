import { redirect } from 'next/navigation';
import { DEFAULT_SYMBOL } from '@velum/config';

export default async function TradeIndex({ searchParams }: { searchParams: Promise<{ mode?: string | string[] }> }) {
  const { mode: m } = await searchParams;
  const mode = m === 'spot' || m === 'perps' ? `?mode=${m}` : '';
  redirect(`/app/trade/${DEFAULT_SYMBOL}${mode}`);
}
