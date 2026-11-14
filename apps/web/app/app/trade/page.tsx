import { redirect } from 'next/navigation';
import { DEFAULT_SYMBOL } from '@velum/config';

export default function TradeIndex({ searchParams }: { searchParams: { mode?: string } }) {
  const mode = searchParams.mode === 'spot' || searchParams.mode === 'perps' ? `?mode=${searchParams.mode}` : '';
  redirect(`/app/trade/${DEFAULT_SYMBOL}${mode}`);
}
