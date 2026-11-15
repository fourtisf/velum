import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { MARKET_SYMBOLS, getMarket } from '@velum/config';
import { TradeView } from '@/components/views/TradeView';

/** Next 15: route params and the query string arrive as promises. */
type Params = Promise<{ symbol: string }>;
type Search = Promise<{ mode?: string | string[] }>;

export function generateStaticParams() {
  return MARKET_SYMBOLS.map((symbol) => ({ symbol }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const m = getMarket((await params).symbol);
  return { title: m ? `Trade ${m.symbol} privately | Velum` : 'Velum' };
}

export default async function TradePage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const [{ symbol }, { mode: q }] = await Promise.all([params, searchParams]);
  const m = getMarket(symbol);
  if (!m) notFound();
  const mode = q === 'spot' || q === 'perps' ? q : undefined;
  if (symbol !== m.symbol) redirect(`/app/trade/${m.symbol}${mode ? `?mode=${mode}` : ''}`);
  return <TradeView symbol={m.symbol} mode={mode} />;
}
