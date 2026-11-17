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
  /** ETH and WETH (Robinhood Chain), at the live ETH price. */
  eth: Wad | null;
  total: Wad | null;
}

const ethLike = (b: Record<string, Wad>, sym: 'ETH' | 'WETH'): Wad | null => {
  const n = b[sym];
  return n === undefined || n === 0n ? 0n : valueOf(sym, n);
};

export function walletValue(b: Record<string, Wad> | undefined, unavailable: readonly string[] = []): WalletValue {
  if (!b) return { usdg: null, held: [], stocks: null, eth: null, total: null };
  const held = STOCK_SYMS.filter((sym) => (b[sym] ?? 0n) > 0n);
  let stocks: Wad | null = 0n;
  for (const sym of held) {
    const v = valueOf(sym, b[sym]!);
    stocks = v === null || stocks === null ? null : stocks + v;
  }
  const usdg = b.USDG ?? null;
  const native = b.ETH === undefined ? null : ethLike(b, 'ETH');
  const wrapped = ethLike(b, 'WETH');
  const eth = native === null || wrapped === null ? null : native + wrapped;
  const total = usdg !== null && stocks !== null && eth !== null && unavailable.length === 0 ? usdg + stocks + eth : null;
  return { usdg, held, stocks, eth, total };
}

/** ETH on Ethereum mainnet ("ERC20"), valued at the live ETH price: null while unknown (not read, or no price). */
export function l1EthValue(wei: bigint | undefined): Wad | null {
  if (wei === undefined) return null;
  return wei === 0n ? 0n : valueOf('ETH', wei); // 18 decimals: wei is already a wad
}

/**
 * The whole wallet: Robinhood Chain (walletValue) plus ETH on Ethereum. While the Ethereum balance is loading the total is
 * unknown; if it cannot be read, the total is Robinhood Chain only and `l1Missing` says so (shown under the total).
 */
export function fullTotal(rh: WalletValue, l1: { wei: bigint | undefined; pending: boolean; error: boolean }): { total: Wad | null; l1Missing: boolean } {
  if (rh.total === null) return { total: null, l1Missing: false };
  if (l1.wei !== undefined) {
    const v = l1EthValue(l1.wei);
    return v === null ? { total: null, l1Missing: false } : { total: rh.total + v, l1Missing: false };
  }
  if (l1.error) return { total: rh.total, l1Missing: true };
  return { total: null, l1Missing: false };
}
