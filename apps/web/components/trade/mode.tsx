'use client';
import { createContext, useContext } from 'react';
import { useApp } from '@/lib/store';

export type TradeMode = 'spot' | 'perps';

/**
 * The trade page's `?mode=` while the store has not taken it yet (final audit W-12). The store is
 * only written in an effect, after hydration; without this the server render and the first client
 * render showed the store's default (Perps) and then flipped to Spot.
 */
export const UrlModeContext = createContext<TradeMode | null>(null);

/** The ticket mode to show: the URL's until the store has it, then the store's (the user's choice). */
export function useTradeMode(): TradeMode {
  const stored = useApp((s) => s.mode);
  return useContext(UrlModeContext) ?? stored;
}
