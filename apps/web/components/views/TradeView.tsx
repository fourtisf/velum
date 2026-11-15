'use client';
import { useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import { Terminal } from '../trade/Terminal';
import { UrlModeContext, type TradeMode } from '../trade/mode';

export function TradeView({ symbol, mode }: { symbol: string; mode?: TradeMode }) {
  const set = useApp((s) => s.set);
  // `?mode=` is applied in the server render and the first client render through the context, then
  // handed to the store, so the ticket never flips after hydration (final audit W-12).
  const key = `${symbol}:${mode ?? ''}`;
  const [applied, setApplied] = useState<string | null>(null);
  useEffect(() => {
    set(mode ? { sel: symbol, mode } : { sel: symbol });
    setApplied(key);
    window.scrollTo(0, 0);
  }, [key, symbol, mode, set]);
  return (
    <UrlModeContext.Provider value={applied === key ? null : (mode ?? null)}>
      <Terminal symbol={symbol} />
    </UrlModeContext.Provider>
  );
}
