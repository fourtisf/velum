'use client';
import { useEffect } from 'react';
import { useApp } from '@/lib/store';
import { Terminal } from '../trade/Terminal';

export function TradeView({ symbol, mode }: { symbol: string; mode?: 'spot' | 'perps' }) {
  const set = useApp((s) => s.set);
  useEffect(() => {
    set(mode ? { sel: symbol, mode } : { sel: symbol });
    window.scrollTo(0, 0);
  }, [symbol, mode, set]);
  return <Terminal symbol={symbol} />;
}
