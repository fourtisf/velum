import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { MARKET_SYMBOLS, getMarket } from '@velum/config';
import { TradeView } from '@/components/views/TradeView';

export function generateStaticParams() {
  return MARKET_SYMBOLS.map((symbol) => ({ symbol }));
}

export function generateMetadata({ params }: { params: { symbol: string } }): Metadata {
  const m = getMarket(params.symbol);
  return { title: m ? `Trade ${m.symbol} privately | Velum` : 'Velum' };
}

export default function TradePage({ params, searchParams }: { params: { symbol: string }; searchParams: { mode?: string } }) {
  const m = getMarket(params.symbol);
  if (!m) notFound();
  const mode = searchParams.mode === 'spot' || searchParams.mode === 'perps' ? searchParams.mode : undefined;
  if (params.symbol !== m.symbol) redirect(`/app/trade/${m.symbol}${mode ? `?mode=${mode}` : ''}`);
  return <TradeView symbol={m.symbol} mode={mode} />;
}
