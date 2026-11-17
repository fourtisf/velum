/**
 * Profit and loss of the Stock Tokens a wallet holds on Robinhood Chain mainnet, from its own trades read from the chain
 * (lib/walletActivity.ts), average-cost method:
 *  - a buy with USDG costs the USDG paid; a buy with ETH costs the USDG the ETH became inside the swap (from the receipt);
 *  - a sell removes the average cost of what was sold (the difference to the USDG received is realized P&L);
 *  - a swap of one Stock Token for another carries the cost over; a send removes the average cost;
 *  - tokens that arrived any other way (a transfer in, or before the activity window) have no known cost.
 * A holding whose cost is not known for all of it shows no P&L (a dash, never a guess). All amounts are wads (18
 * decimals; USDG converted from its 6).
 */
import { isMarketSymbol } from '@velum/config';
import type { Wad } from '@velum/math';
import type { Move, WalletAct } from './walletActivity';

export interface Basis {
  /** Tokens whose cost is tracked (wad). */
  qty: Wad;
  /** Their total cost in USDG (wad). */
  cost: Wad;
  /** P&L already realized by sells in the window (wad). */
  realized: Wad;
  /** Some of the tokens came without a known cost: no P&L for this holding. */
  unknown: boolean;
}

const wad = (m: Move): Wad => m.units * 10n ** BigInt(18 - m.decimals);
const usdgIn = (moves: Move[]): Wad => moves.filter((m) => m.sym === 'USDG').reduce((a, m) => a + wad(m), 0n);
const stocks = (moves: Move[]) => moves.filter((m) => isMarketSymbol(m.sym));

/** Cost basis per Stock Token from the wallet's activity (any order: it is replayed oldest first). */
export function costBasis(acts: readonly WalletAct[]): Record<string, Basis> {
  const out: Record<string, Basis> = {};
  const get = (sym: string) => (out[sym] ??= { qty: 0n, cost: 0n, realized: 0n, unknown: false });
  /** Takes `q` tokens out at the average cost; returns that cost. Taking more than is tracked makes the basis unknown. */
  const take = (sym: string, q: Wad): Wad => {
    const b = get(sym);
    if (q > b.qty) {
      b.unknown = true;
      const c = b.cost;
      b.qty = 0n;
      b.cost = 0n;
      return c;
    }
    const c = b.qty === 0n ? 0n : (b.cost * q) / b.qty;
    b.qty -= q;
    b.cost -= c;
    return c;
  };
  const oldestFirst = [...acts].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
  for (const a of oldestFirst) {
    const ins = stocks(a.in);
    const outs = stocks(a.out);
    if (a.kind === 'buy') {
      // Paid with USDG (what left the wallet), or with ETH (the USDG it became in the swap); unknown otherwise.
      const paid = a.ethPaid > 0n ? (a.usdCost === null ? null : a.usdCost * 10n ** 12n) : a.out.length ? usdgIn(a.out) : null;
      const total = ins.reduce((s, m) => s + wad(m), 0n);
      for (const m of ins) {
        const b = get(m.sym);
        b.qty += wad(m);
        if (paid === null || total === 0n) b.unknown = true;
        else b.cost += (paid * wad(m)) / total;
      }
    } else if (a.kind === 'sell') {
      const proceeds = usdgIn(a.in);
      const sold = outs.reduce((s, m) => s + wad(m), 0n);
      for (const m of outs) {
        const known = !get(m.sym).unknown && wad(m) <= get(m.sym).qty;
        const c = take(m.sym, wad(m));
        if (known && sold > 0n) get(m.sym).realized += (proceeds * wad(m)) / sold - c;
      }
    } else if (a.kind === 'swap') {
      const unknownIn = outs.some((m) => get(m.sym).unknown || wad(m) > get(m.sym).qty);
      const carried = outs.reduce((s, m) => s + take(m.sym, wad(m)), 0n);
      const total = ins.reduce((s, m) => s + wad(m), 0n);
      for (const m of ins) {
        const b = get(m.sym);
        b.qty += wad(m);
        if (unknownIn || total === 0n) b.unknown = true;
        else b.cost += (carried * wad(m)) / total;
      }
    } else if (a.kind === 'send') {
      for (const m of outs) take(m.sym, wad(m));
    } else {
      // A transfer in: no known cost.
      for (const m of ins) {
        const b = get(m.sym);
        b.qty += wad(m);
        b.unknown = true;
      }
    }
  }
  return out;
}

/** Tracked and held amounts may differ by rounding dust only (1e-9 of a token). */
const DUST = 10n ** 9n;

export interface Pnl {
  /** What the holding cost (wad, USDG). */
  cost: Wad;
  /** Value now minus cost (wad). */
  pnl: Wad;
  /** pnl / cost, in basis points. */
  bps: number;
}

/**
 * P&L of holding `held` tokens worth `value` now: null when the cost is not known for all of them (some came without a
 * cost, or the wallet holds more than its trades in the window explain), or there is no live value.
 */
export function pnlOf(b: Basis | undefined, held: Wad, value: Wad | null): Pnl | null {
  if (!b || b.unknown || value === null || held <= 0n || b.cost <= 0n) return null;
  if (held > b.qty + DUST || held + DUST < b.qty) return null;
  const pnl = value - b.cost;
  return { cost: b.cost, pnl, bps: Number((pnl * 10_000n) / b.cost) };
}
