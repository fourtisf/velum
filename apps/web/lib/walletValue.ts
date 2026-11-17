/**
 * What a wallet on Robinhood Chain is worth at live prices: USDG at 1, Stock Tokens at their live price, ETH at the
 * live pool price (lib/uniswap/ethPrice.ts). A held token without a live price, or a balance that could not be read,
 * leaves the total unknown (null): a dash, never a guess.
 */
import { TOKENS } from '@velum/config';
import type { Wad } from '@velum/math';
import { valueOf } from './calc';

export const STOCK_SYMS = Object.keys(TOKENS).filter((sym) => sym !== 'USDG');

export interface WalletValue {
  usdg: Wad | null;
  /** Stock Tokens held (a balance above zero), in market order. */
  held: string[];
  stocks: Wad | null;
  eth: Wad | null;
  total: Wad | null;
}

export function walletValue(b: Record<string, Wad> | undefined, unavailable: readonly string[] = []): WalletValue {
  if (!b) return { usdg: null, held: [], stocks: null, eth: null, total: null };
  const held = STOCK_SYMS.filter((sym) => (b[sym] ?? 0n) > 0n);
  let stocks: Wad | null = 0n;
  for (const sym of held) {
    const v = valueOf(sym, b[sym]!);
    stocks = v === null || stocks === null ? null : stocks + v;
  }
  const usdg = b.USDG ?? null;
  const eth = b.ETH === undefined ? null : b.ETH === 0n ? 0n : valueOf('ETH', b.ETH);
  const total = usdg !== null && stocks !== null && eth !== null && unavailable.length === 0 ? usdg + stocks + eth : null;
  return { usdg, held, stocks, eth, total };
}
