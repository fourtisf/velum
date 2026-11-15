/**
 * Exact, integer-only quotes for the Phase 3 contracts, mirroring their arithmetic (contracts/src:
 * PerpsMarkets._match/_collectMargin, PerpsBase._exitPrice/_closeFee, SpotPools) so what the ticket shows
 * before signing is what the chain computes. No floats: prices are USDG per token x 1e18, quantities
 * token base units (1e18), USDG amounts USDG base units (6 decimals on Robinhood Chain; read from chain).
 *
 * Slippage, price limits and minimums: every write carries a non-zero limit derived from the user's
 * slippage setting (0.1 / 0.5 / 1%, default 0.5%), always rounded against the user (never looser).
 */
import { PROTOCOL } from '@velum/config';

export const BPS = 10_000n;
/** PerpsBase constants (checked against the contract sources by tests/onchain-quote.test.ts). */
export const PERPS = {
  maxLeverage: 5n,
  /** Initial margin: 1 / maxLeverage. */
  imBps: 2000n,
  /** Maintenance margin: 0.5 / maxLeverage. */
  mmBps: 1000n,
  takerFeeBps: BigInt(PROTOCOL.takerFeeBps),
  penaltyBps: BigInt(PROTOCOL.liquidationPenaltyBps),
  maxQty: BigInt(PROTOCOL.maxTokensPerPosition) * 10n ** 18n,
} as const;
/** SpotPools.FEE_BPS. */
export const POOL_FEE_BPS = BigInt(PROTOCOL.spotPoolFeeBps);
/** MakerBook.MIN_OPEN_SPREAD_BPS and MAX_SPREAD_BPS. */
export const OFFER_SPREAD = { minOpen: 2, max: 500 } as const;

const divUp = (a: bigint, b: bigint): bigint => (a === 0n ? 0n : (a - 1n) / b + 1n);
const mulDivDown = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d;
const mulDivUp = (a: bigint, b: bigint, d: bigint): bigint => divUp(a * b, d);

/** The slippage setting (percent) as basis points: 0.1 -> 10, 0.5 -> 50, 1 -> 100. Only the offered options. */
export function slipBps(pct: number): bigint {
  const allowed = PROTOCOL.slippageOptionsPct as readonly number[];
  const p = allowed.includes(pct) ? pct : PROTOCOL.defaultSlippagePct;
  return BigInt(Math.round(p * 100));
}

/** Leverage (1 to 5 in 0.5 steps) as the contract's `leverageHalf` (2 to 10), or null when invalid. */
export function leverageHalf(lev: number): number | null {
  const h = Math.round(lev * 2);
  return Number.isFinite(lev) && Math.abs(lev * 2 - h) < 1e-9 && h >= 2 && h <= Number(PERPS.maxLeverage) * 2 ? h : null;
}

/** USDG decimals -> PerpsMarkets.valueScale = 10^(36 - usdgDecimals). */
export const valueScaleFor = (usdgDecimals: number): bigint => 10n ** BigInt(36 - usdgDecimals);

export interface OpenQuote {
  entry: bigint;
  qty: bigint;
  takerMargin: bigint;
  makerMargin: bigint;
  fee: bigint;
  /** takerMargin + fee: what leaves the free vault balance. */
  cost: bigint;
  /** Worst acceptable entry sent as `priceLimit` (never zero). */
  priceLimit: bigint;
  /** Taker liquidation price before funding (null: none). */
  liq: bigint | null;
}

/**
 * Open at oracle price `price` against an offer with `openBps`: entry = price x (1 +/- spread) worse for the
 * taker (up for longs, down for shorts), margin = size x 2 / leverageHalf (up), fee 0.06% of size (up),
 * qty = size x valueScale / entry (down).
 */
export function openQuote(p: { price: bigint; size: bigint; levHalf: number; long: boolean; openBps: number; slipBps: bigint; valueScale: bigint }): OpenQuote {
  const o = BigInt(p.openBps);
  const entry = p.long ? mulDivUp(p.price, BPS + o, BPS) : mulDivDown(p.price, BPS - o, BPS);
  const qty = entry > 0n ? mulDivDown(p.size, p.valueScale, entry) : 0n;
  const takerMargin = mulDivUp(p.size, 2n, BigInt(p.levHalf));
  const makerMargin = mulDivUp(p.size, PERPS.imBps, BPS);
  const fee = mulDivUp(p.size, PERPS.takerFeeBps, BPS);
  const priceLimit = openLimit(entry, p.long, p.slipBps);
  return { entry, qty, takerMargin, makerMargin, fee, cost: takerMargin + fee, priceLimit, liq: liquidationPrice({ long: p.long, qty, entry, margin: takerMargin, valueScale: p.valueScale }) };
}

/** Worst acceptable entry: entry x (1 + slip) up for longs, entry x (1 - slip) down for shorts; at least 1. */
export function openLimit(entry: bigint, long: boolean, slip: bigint): bigint {
  const l = long ? mulDivUp(entry, BPS + slip, BPS) : mulDivDown(entry, BPS - slip, BPS);
  return l > 0n ? l : 1n;
}

/**
 * The price at which the taker side falls below the 10% maintenance margin (funding ignored):
 * long: margin + qty(P - E)/V < MM x qty x P / V, so P < (qty E - margin V) / (qty (1 - MM));
 * short: P > (qty E + margin V) / (qty (1 + MM)). Null when there is none (a fully covered long).
 */
export function liquidationPrice(p: { long: boolean; qty: bigint; entry: bigint; margin: bigint; valueScale: bigint }): bigint | null {
  if (p.qty <= 0n) return null;
  if (p.long) {
    const num = p.qty * p.entry - p.margin * p.valueScale;
    if (num <= 0n) return null;
    return mulDivDown(num, BPS, p.qty * (BPS - PERPS.mmBps));
  }
  return mulDivUp(p.qty * p.entry + p.margin * p.valueScale, BPS, p.qty * (BPS + PERPS.mmBps));
}

/** Spread-adjusted exit of a close: price x (1 - cs) down for longs, price x (1 + cs) up for shorts. */
export function exitPrice(price: bigint, long: boolean, closeBps: number): bigint {
  const c = BigInt(closeBps);
  return long ? mulDivDown(price, BPS - c, BPS) : mulDivUp(price, BPS + c, BPS);
}

/** Close fee: 0.06% of exit notional, rounded up (PerpsBase._closeFee). */
export const closeFee = (qty: bigint, exit: bigint, valueScale: bigint): bigint => mulDivUp(qty, exit * PERPS.takerFeeBps, valueScale * BPS);

/** Worst acceptable exit sent as the close `priceLimit`: exit x (1 - slip) for longs (at least 1), x (1 + slip) for shorts. */
export function closeLimit(exit: bigint, long: boolean, slip: bigint): bigint {
  const l = long ? mulDivDown(exit, BPS - slip, BPS) : mulDivUp(exit, BPS + slip, BPS);
  return l > 0n ? l : 1n;
}

/** Taker P&L at `price` in USDG base units, rounded down (against the taker) like PerpsBase._takerPnl. */
export function takerPnl(long: boolean, qty: bigint, entry: bigint, price: bigint, valueScale: bigint): bigint {
  const n = qty * (long ? price - entry : entry - price);
  return n >= 0n ? n / valueScale : -divUp(-n, valueScale);
}

/** Minimum output for a quoted amount: quote x (1 - slip), rounded down. Zero means the trade is too small to protect. */
export const minOut = (quote: bigint, slip: bigint): bigint => mulDivDown(quote, BPS - slip, BPS);

/** One pool's constant-product output after the 0.30% fee (SpotPools._quote). */
export function poolOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (reserveIn === 0n || reserveOut === 0n) return 0n;
  const inAfterFee = mulDivDown(amountIn, BPS - POOL_FEE_BPS, BPS);
  return mulDivDown(inAfterFee, reserveOut, reserveIn + inAfterFee);
}

/** The pool fee taken from an input amount (what stays in the pool). */
export const poolFee = (amountIn: bigint): bigint => amountIn - mulDivDown(amountIn, BPS - POOL_FEE_BPS, BPS);

export interface PoolState {
  stockReserve: bigint;
  usdgReserve: bigint;
  totalShares: bigint;
}

/** Shares `addLiquidity` mints for at most these amounts (SpotPools: min of both ratios; first deposit sqrt - 1000). */
export function sharesFor(pool: PoolState, maxStock: bigint, maxUsdg: bigint): bigint {
  if (maxStock <= 0n || maxUsdg <= 0n) return 0n;
  if (pool.totalShares === 0n) {
    const root = sqrt(maxStock * maxUsdg);
    return root > 1000n ? root - 1000n : 0n;
  }
  if (pool.stockReserve === 0n || pool.usdgReserve === 0n) return 0n;
  const a = mulDivDown(maxStock, pool.totalShares, pool.stockReserve);
  const b = mulDivDown(maxUsdg, pool.totalShares, pool.usdgReserve);
  return a < b ? a : b;
}

/** What `removeLiquidity` returns for `shares` (rounded down). */
export function removeQuote(pool: PoolState, shares: bigint): { stock: bigint; usdg: bigint } {
  if (pool.totalShares === 0n || shares <= 0n) return { stock: 0n, usdg: 0n };
  return { stock: mulDivDown(shares, pool.stockReserve, pool.totalShares), usdg: mulDivDown(shares, pool.usdgReserve, pool.totalShares) };
}

/** Integer square root, rounded down. */
export function sqrt(x: bigint): bigint {
  if (x < 0n) throw new RangeError('sqrt of a negative number');
  if (x < 2n) return x;
  let r = x;
  let y = (x + 1n) >> 1n;
  while (y < r) {
    r = y;
    y = (x / y + y) >> 1n;
  }
  return r;
}

/** Stock tokens worth `usdg` at `price` (USDG per token x 1e18): usdg x 10^(36 - usdgDecimals) / price, rounded down. */
export function stockForUsdg(usdg: bigint, price: bigint, valueScale: bigint): bigint {
  return price > 0n ? mulDivDown(usdg, valueScale, price) : 0n;
}

/** USDG value (base units) of `qty` tokens at `price`, rounded down. */
export const valueOfQty = (qty: bigint, price: bigint, valueScale: bigint): bigint => mulDivDown(qty, price, valueScale);

/* ---------------------------------------------------------------- offers: the full cost of a round trip */

/**
 * A spread above this needs an explicit acknowledgement in the review (web audit W3-03). 50 bps is 0.5% of the
 * position's size: ten times the 5 bps the reference maker quotes, more than eight times the 0.06% taker fee,
 * and 2.5% of the margin at 5x, lost at the close even if the price never moves. MakerBook allows up to 500 bps
 * (5%: a quarter of the margin at 5x), so a taker must not drift into such an offer without seeing it.
 */
export const HIGH_SPREAD_BPS = 50;

export interface RoundTrip {
  /** Lost to the open and close spreads at an unchanged price (USDG base units). */
  spread: bigint;
  /** The 0.06% open fee plus the 0.06% close fee on exit notional. */
  fees: bigint;
  /** spread + fees: what opening and closing right away costs at an unchanged price. */
  total: bigint;
}

/**
 * Opening `size` against an offer and closing it at the same oracle `price`, as the contracts compute it
 * (openQuote, exitPrice, closeFee, takerPnl): the honest cost of an offer, its close spread included. Funding
 * is left out (it does not depend on the offer).
 */
export function roundTrip(p: { price: bigint; size: bigint; levHalf: number; long: boolean; openBps: number; closeBps: number; valueScale: bigint }): RoundTrip {
  const q = openQuote({ price: p.price, size: p.size, levHalf: p.levHalf, long: p.long, openBps: p.openBps, slipBps: 0n, valueScale: p.valueScale });
  const exit = exitPrice(p.price, p.long, p.closeBps);
  const pnl = takerPnl(p.long, q.qty, q.entry, exit, p.valueScale);
  const fees = q.fee + closeFee(q.qty, exit, p.valueScale);
  const spread = pnl < 0n ? -pnl : 0n;
  return { spread, fees, total: spread + fees };
}

/** Whether taking this offer needs the explicit acknowledgement (either spread above HIGH_SPREAD_BPS). */
export const highSpread = (o: { openBps: number; closeBps: number }): boolean => o.closeBps > HIGH_SPREAD_BPS || o.openBps > HIGH_SPREAD_BPS;

/**
 * The most a taker can make on one position: the maker's margin (S/maxL, 20% of size). Beyond about a 10% move
 * the maker side is liquidated and the taker receives the pool (contracts/README.md, simplifications).
 */
export const takerProfitCap = (size: bigint): bigint => mulDivUp(size, PERPS.imBps, BPS);

/* ---------------------------------------------------------------- close on a liquidatable position */

export interface LiquidationQuote {
  /** The taker's side is the one liquidated (else the maker's). */
  takerSide: boolean;
  /** The taker's share of the pool after the penalty (USDG base units). */
  takerOut: bigint;
  /** The 1% penalty the liquidated side pays (capped at its claim). */
  penalty: bigint;
  /** The liquidator half of the penalty, paid to the closing taker (the liquidator). */
  reward: bigint;
  /** The insurance top-up of the reward when the loser cannot pay it (at most the cap, if the epoch allows). */
  topUp: bigint;
  /** A shortfall the taker files as a cover claim (maker side insolvent). */
  shortfall: bigint;
}

/**
 * What `close` pays when the position is liquidatable (PerpsLiquidation._liquidationSplit with the taker as
 * liquidator): the oracle price with no close spread and no close fee; the liquidated side pays 1% of notional
 * (capped at its claim), half of it back to the liquidator (here the taker), topped up from insurance to half
 * the full penalty (at most `rewardCap`) when the loser cannot pay. `takerClaim` is PerpsMarkets.takerClaimAt
 * at that price (funding included). Null when neither side is below maintenance.
 */
export function liquidationQuote(p: { takerClaim: bigint; takerMargin: bigint; makerMargin: bigint; qty: bigint; price: bigint; valueScale: bigint; rewardCap: bigint }): LiquidationQuote | null {
  const pool = p.takerMargin + p.makerMargin;
  const makerClaim = pool - p.takerClaim;
  const notional = mulDivUp(p.qty, p.price, p.valueScale);
  const req = mulDivUp(notional, PERPS.mmBps, BPS);
  let takerSide: boolean;
  if (p.takerClaim < req && p.takerClaim <= makerClaim) takerSide = true;
  else if (makerClaim < req) takerSide = false;
  else return null;
  const loserClaim = takerSide ? p.takerClaim : makerClaim;
  const fullPenalty = mulDivUp(notional, PERPS.penaltyBps, BPS);
  let penalty = 0n;
  let loserOut = 0n;
  let shortfall = 0n;
  if (loserClaim <= 0n) shortfall = -loserClaim;
  else {
    penalty = loserClaim < fullPenalty ? loserClaim : fullPenalty;
    loserOut = loserClaim - penalty;
  }
  const winnerOut = pool - loserOut - penalty;
  const reward = penalty / 2n;
  const target = fullPenalty / 2n < p.rewardCap ? fullPenalty / 2n : p.rewardCap;
  return { takerSide, takerOut: takerSide ? loserOut : winnerOut, penalty, reward, topUp: reward < target ? target - reward : 0n, shortfall: takerSide ? 0n : shortfall };
}

/* ---------------------------------------------------------------- add liquidity: the reviewed plan */

export interface LpAddPlan {
  /** USDG swapped into the stock. */
  half: bigint;
  /** Stock the swap returns at the reviewed reserves, and its minimum (slippage). */
  stockOut: bigint;
  minStock: bigint;
  /** Shares the add mints at the reserves the user's own swap leaves (reviewed), and their minimum. */
  shares: bigint;
  minShares: bigint;
}

/**
 * The two-step add (swap half of `usdg` into the stock, then add both) planned from the reserves the user
 * reviewed (web audit W3-07): the add's `minShares` comes from the pool as the user's own swap leaves it, not
 * from live reserves read just before the second transaction (which anyone can move in between).
 */
export function lpAddPlan(pool: PoolState, usdg: bigint, slip: bigint): LpAddPlan {
  const half = usdg / 2n;
  const stockOut = poolOut(half, pool.usdgReserve, pool.stockReserve);
  const after: PoolState = { stockReserve: pool.stockReserve - stockOut, usdgReserve: pool.usdgReserve + half, totalShares: pool.totalShares };
  const shares = sharesFor(after, stockOut, usdg - half);
  return { half, stockOut, minStock: minOut(stockOut, slip), shares, minShares: minOut(shares, slip) };
}
