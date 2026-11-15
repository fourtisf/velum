/**
 * What the account holds in the Velum contracts, valued in USDG base units at the oracle prices: free vault
 * balances, open positions (margin plus unrealised P&L, funding excluded), unused offer backing and pool
 * shares. Pure and integer-only. A holding without a price makes the total null (shown as a dash), never a
 * total that silently leaves it out.
 */
import type { ChainPosition, Offer, PoolRead } from './reads';
import { takerPnl } from './quote';

/** USDG value (base units) of `units` of a token with `dec` decimals at `price` (USDG per token x 1e18). */
export function tokenValue(units: bigint, dec: number, price: bigint, usdgDec: number): bigint {
  return (units * price) / 10n ** BigInt(dec + 18 - usdgDec);
}

export interface TotalsInput {
  vault: Record<string, bigint>;
  decimals: Record<string, number>;
  prices: Record<string, bigint | null | undefined>;
  positions: readonly ChainPosition[];
  /** The account's active offers (unused backing). */
  offers: readonly Offer[];
  pools: Record<string, PoolRead>;
  valueScale: bigint;
}

/** Value of one open position to the account: its margin plus its side's P&L at `price`. */
export function positionValue(p: ChainPosition, price: bigint, valueScale: bigint): bigint {
  const t = takerPnl(p.long, p.qty, p.entry, price, valueScale);
  return p.role === 'taker' ? p.takerMargin + t : p.makerMargin - t;
}

export function vaultTotals(i: TotalsInput): { total: bigint | null; inPositions: bigint | null } {
  const ud = i.decimals.USDG;
  if (ud === undefined) return { total: null, inPositions: null };
  let total = i.vault.USDG ?? 0n;
  let priced = true;
  for (const [sym, units] of Object.entries(i.vault)) {
    if (sym === 'USDG' || units === 0n) continue;
    const px = i.prices[sym];
    const d = i.decimals[sym];
    if (!px || d === undefined) priced = false;
    else total += tokenValue(units, d, px, ud);
  }
  let inPositions: bigint | null = 0n;
  for (const p of i.positions) {
    const px = i.prices[p.sym];
    if (!px) {
      inPositions = null;
      break;
    }
    inPositions += positionValue(p, px, i.valueScale);
  }
  for (const o of i.offers) total += o.backing;
  for (const pool of Object.values(i.pools)) {
    if (pool.mine === 0n || pool.totalShares === 0n) continue;
    const px = i.prices[pool.sym];
    const d = i.decimals[pool.sym];
    const usdg = (pool.usdgReserve * pool.mine) / pool.totalShares;
    const stock = (pool.stockReserve * pool.mine) / pool.totalShares;
    if (!px || d === undefined) priced = false;
    else total += usdg + tokenValue(stock, d, px, ud);
  }
  if (inPositions === null || !priced) return { total: null, inPositions };
  return { total: total + inPositions, inPositions };
}
