'use client';
/**
 * Builders of the real (Phase 3) flows. Each returns a TxFlowSpec: review rows with the exact amounts that
 * will move (in the token's own decimals), fees and price limits, then one step per transaction. Approvals
 * are exact (an ERC-20 approve of exactly the deposit, never unlimited) and module approvals are asked only
 * when missing, both checked on chain when the step runs. Every trade carries a non-zero price limit or
 * minimum from the slippage setting.
 */
import { parseEventLogs, type Address, type TransactionReceipt } from 'viem';
import { publicClient } from '../chain';
import { fmt, fmtLev, shortH } from '../format';
import { BOOK_ABI, ERC20_ABI, PERPS_ABI, SPOT_ABI, VAULT_ABI } from './abi';
import type { OnchainInfo } from './deployment';
import type { Row, TxFlowSpec, TxRunCtx, TxStepSpec } from './flow';
import { closeLimit, minOut, openLimit, removeQuote, sharesFor, type OpenQuote, type PoolState } from './quote';
import { MODULES, rememberPosition, type ChainPosition, type ModuleKey, type Offer, type Protocol } from './reads';
import { unitsToWad } from './units';

type A = `0x${string}`;

export interface FlowBase {
  oc: OnchainInfo;
  proto: Protocol;
  account: Address;
}

/** Deadline for pool actions: 20 minutes after the latest block (chain time, not this device's clock). */
export const DEADLINE_S = 1200n;
const deadline = async () => (await publicClient.getBlock({ blockTag: 'latest' })).timestamp + DEADLINE_S;

/** Exact amount in a token's decimals with thousands separators, e.g. 1,234.5 USDG (no rounding). */
export function exact(units: bigint, decimals: number, sym?: string): string {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const int = (v / base).toLocaleString('en-US');
  const frac = decimals ? (v % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}${sym ? ' ' + sym : ''}`;
}

/** A display amount rounded to `dp` decimals (estimates: prices, P&L). */
export const approx = (units: bigint, decimals: number, dp = 2): string => fmt(unitsToWad(units, decimals), dp);
/** A 1e18 price as USDG with 2 decimals. */
export const price = (p: bigint): string => fmt(p, 2);

const dec = (b: FlowBase, sym: string): number => b.proto.decimals[sym]!;
const token = (b: FlowBase, sym: string): A => b.oc.d.tokens[sym] as A;
const usdg = (b: FlowBase, units: bigint) => exact(units, dec(b, 'USDG'), 'USDG');

const MODULE_NAME: Record<ModuleKey, string> = { perps: 'perps market', spot: 'spot pools', book: 'maker book' };

/** One-time module approval in the vault, skipped when already given (read on chain when the step runs). */
export function moduleStep(b: FlowBase, m: ModuleKey): TxStepSpec {
  const vault = b.oc.d.contracts.vault as A;
  const target = b.oc.d.contracts[MODULES[m]] as A;
  return {
    t: `Allow the Velum ${MODULE_NAME[m]} to use your vault balance`,
    d: 'A one-time approval in the vault, only for this contract',
    label: 'Approval',
    call: async (ctx) => {
      const ok = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'approved', args: [ctx.account, target] });
      return ok ? null : { address: vault, abi: VAULT_ABI, functionName: 'setApproval', args: [target, true] };
    },
  };
}

const events = <T extends readonly unknown[]>(abi: T, r: TransactionReceipt) => parseEventLogs({ abi: abi as never, logs: r.logs }) as unknown as Array<{ eventName: string; args: Record<string, unknown> }>;
const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : 0n);

/* ---------------------------------------------------------------- vault */

/** Shield = deposit into the vault: an exact ERC-20 approval when the allowance is short, then the deposit. */
export function depositFlow(b: FlowBase, sym: string, units: bigint): TxFlowSpec {
  const vault = b.oc.d.contracts.vault as A;
  const t = token(b, sym);
  const amount = exact(units, dec(b, sym), sym);
  return {
    title: `Shield ${sym}`,
    review: [
      ['Deposit', amount],
      ['Token approval', `Exactly ${amount}, only if needed`],
      ['To', 'Your Velum vault balance'],
      ['Visible onchain', 'Your wallet, the token and the amount'],
    ],
    note: 'In this phase a deposit and your vault balance are public onchain. The privacy layer comes later.',
    steps: [
      {
        t: `Approve exactly ${amount}`,
        d: 'Lets the Velum vault take this amount from your wallet, and nothing more',
        label: 'Token approval',
        call: async (ctx) => {
          const have = await publicClient.readContract({ address: t, abi: ERC20_ABI, functionName: 'allowance', args: [ctx.account, vault] });
          return have >= units ? null : { address: t, abi: ERC20_ABI, functionName: 'approve', args: [vault, units] };
        },
      },
      {
        t: `Deposit ${amount}`,
        d: 'Into your Velum vault balance',
        label: 'Deposit',
        call: () => ({ address: vault, abi: VAULT_ABI, functionName: 'deposit', args: [t, units, b.account] }),
        after: (r, ctx) => {
          const ev = events(VAULT_ABI, r).find((e) => e.eventName === 'Deposited');
          ctx.out.received = big(ev?.args.amount);
        },
      },
    ],
    done: (ctx) => ({ rows: [['Token', sym], ['Deposited', exact(big(ctx.out.received) || units, dec(b, sym), sym)], ['Vault balance', 'Updated']], toast: `Shielded ${sym}` }),
    ...b,
    d: b.oc.d,
  };
}

/** Unshield = withdraw from the vault to a wallet address. Never blocked by the launch guard. */
export function withdrawFlow(b: FlowBase, sym: string, units: bigint, to: Address): TxFlowSpec {
  const vault = b.oc.d.contracts.vault as A;
  const amount = exact(units, dec(b, sym), sym);
  return {
    title: `Unshield ${sym}`,
    review: [
      ['Withdraw', amount],
      ['To', shortH(to)],
      ['Visible onchain', 'The address, the token and the amount'],
    ],
    steps: [
      {
        t: `Withdraw ${amount}`,
        d: `To ${shortH(to)}`,
        label: 'Withdrawal',
        call: () => ({ address: vault, abi: VAULT_ABI, functionName: 'withdraw', args: [token(b, sym), units, to] }),
      },
    ],
    done: () => ({ rows: [['Token', sym], ['Withdrawn', amount], ['To', shortH(to)]], toast: `Unshielded ${sym}` }),
    ...b,
    d: b.oc.d,
  };
}

/* ---------------------------------------------------------------- perps */

export interface OpenInput {
  sym: string;
  long: boolean;
  lev: number;
  levHalf: number;
  size: bigint;
  offer: Offer;
  q: OpenQuote;
  slip: bigint;
  /** Oracle price the quote used. */
  oraclePrice: bigint;
}

export function openFlow(b: FlowBase, i: OpenInput): TxFlowSpec {
  const perps = b.oc.d.contracts.perpsMarkets as A;
  const Side = i.long ? 'Long' : 'Short';
  const ud = dec(b, 'USDG');
  return {
    title: `Open ${i.long ? 'long' : 'short'} ${i.sym}`,
    review: [
      ['Market', `${i.sym} perp`],
      ['Side', `${Side} ${fmtLev(i.lev)}`],
      ['Size', usdg(b, i.size)],
      ['Margin', usdg(b, i.q.takerMargin)],
      ['Fee (0.06%)', usdg(b, i.q.fee)],
      ['Total from your vault', usdg(b, i.q.cost)],
      ['Entry (est.)', price(i.q.entry)],
      ['Price limit', `${i.long ? 'At most' : 'At least'} ${price(i.q.priceLimit)} (${Number(i.slip) / 100}% slippage)`],
      ['Position (est.)', `${fmt(i.q.qty, 4)} ${i.sym}`],
      ['Liquidation (est.)', i.q.liq ? price(i.q.liq) : 'None'],
      ['Maker offer', `#${i.offer.id} (${i.offer.openBps} bps open, ${i.offer.closeBps} bps close spread)`],
    ],
    note: 'Phase 3: this position is public onchain (size, side, entry and owner). The liquidation price excludes funding.',
    steps: [
      moduleStep(b, 'perps'),
      {
        t: `Open ${Side.toLowerCase()} ${i.sym}`,
        d: `Against maker offer #${i.offer.id}, only at or ${i.long ? 'below' : 'above'} ${price(i.q.priceLimit)}`,
        label: 'Open',
        waitFor: ['StalePrice', 'PriceLagging'],
        call: () => ({ address: perps, abi: PERPS_ABI, functionName: 'open', args: [i.offer.id, token(b, i.sym), i.long, i.size, i.levHalf, i.q.priceLimit] }),
        after: (r, ctx) => {
          const ev = events(PERPS_ABI, r).find((e) => e.eventName === 'PositionChanged');
          if (!ev) return;
          const id = big(ev.args.id);
          ctx.out.id = id;
          ctx.out.entry = big(ev.args.entry);
          ctx.out.qty = big(ev.args.qty);
          ctx.out.margin = big(ev.args.takerMargin);
          rememberPosition(ctx.account, id, r.transactionHash);
        },
      },
    ],
    done: (ctx) => ({
      rows: [
        ['Market', `${i.sym} perp`],
        ['Side', `${Side} ${fmtLev(i.lev)}`],
        ['Position', `${fmt(big(ctx.out.qty), 4)} ${i.sym}`],
        ['Entry', price(big(ctx.out.entry))],
        ['Margin', exact(big(ctx.out.margin), ud, 'USDG')],
        ['Fee', usdg(b, i.q.fee)],
        ['Position ID', `#${String(ctx.out.id ?? '')}`],
      ],
      toast: `${Side} opened on ${i.sym}`,
    }),
    ...b,
    d: b.oc.d,
  };
}

export interface CloseInput {
  pos: ChainPosition;
  exit: bigint;
  fee: bigint;
  /** Estimated return (claim at exit minus the fee, at least 0). */
  estOut: bigint;
  slip: bigint;
}

export function closeFlow(b: FlowBase, i: CloseInput): TxFlowSpec {
  const perps = b.oc.d.contracts.perpsMarkets as A;
  const limit = closeLimit(i.exit, i.pos.long, i.slip);
  const ud = dec(b, 'USDG');
  return {
    title: `Close ${i.pos.long ? 'long' : 'short'} ${i.pos.sym}`,
    review: [
      ['Position', `#${i.pos.id}: ${fmt(i.pos.qty, 4)} ${i.pos.sym} ${i.pos.long ? 'long' : 'short'}`],
      ['Exit (est.)', price(i.exit)],
      ['Price limit', `${i.pos.long ? 'At least' : 'At most'} ${price(limit)} (${Number(i.slip) / 100}% slippage)`],
      ['Close fee (0.06%)', usdg(b, i.fee)],
      ['Returned (est.)', usdg(b, i.estOut)],
    ],
    note: 'Settles at the oracle price minus the close spread your maker committed to. If the position is liquidatable now, it settles as a liquidation instead.',
    steps: [
      {
        t: 'Settling at the current price',
        d: `Only at or ${i.pos.long ? 'above' : 'below'} ${price(limit)}, no maker signature needed`,
        label: 'Close',
        waitFor: ['PriceLagging', 'StalePrice'],
        call: () => ({ address: perps, abi: PERPS_ABI, functionName: 'close', args: [i.pos.id, limit] }),
        after: (r, ctx) => {
          const evs = events(PERPS_ABI, r);
          const s = evs.find((e) => e.eventName === 'PositionSettled');
          ctx.out.liquidated = evs.some((e) => e.eventName === 'Liquidated');
          if (s) {
            ctx.out.exit = big(s.args.exitPrice);
            ctx.out.pnl = big(s.args.takerPnl);
            ctx.out.fee = big(s.args.fee);
            ctx.out.out = big(s.args.takerOut);
          }
        },
      },
    ],
    done: (ctx) => ({
      rows: [
        ['Exit price', price(big(ctx.out.exit))],
        ['P&L', `${big(ctx.out.pnl) >= 0n ? '+' : ''}${exact(big(ctx.out.pnl), ud, 'USDG')}`],
        [ctx.out.liquidated ? 'Penalty' : 'Fee', exact(big(ctx.out.fee), ud, 'USDG')],
        ['Returned', exact(big(ctx.out.out), ud, 'USDG')],
        ...(ctx.out.liquidated ? ([['Settled as', 'Liquidation (the position was below maintenance)']] as Row[]) : []),
      ],
      toast: 'Position closed',
    }),
    ...b,
    d: b.oc.d,
  };
}

export function marginFlow(b: FlowBase, pos: ChainPosition, add: boolean, units: bigint): TxFlowSpec {
  const perps = b.oc.d.contracts.perpsMarkets as A;
  const amount = usdg(b, units);
  const current = pos.role === 'taker' ? pos.takerMargin : pos.makerMargin;
  const after = add ? current + units : current - units;
  return {
    title: `${add ? 'Add' : 'Remove'} margin`,
    review: [
      ['Position', `#${pos.id} ${pos.sym} ${pos.long ? 'long' : 'short'}`],
      [add ? 'Add' : 'Remove', amount],
      ['Margin after', usdg(b, after)],
    ],
    note: add ? 'Adding margin lowers the liquidation risk. Funds come from your vault balance.' : 'You can remove margin down to the 20% initial margin. Funds go back to your vault balance.',
    steps: [
      ...(add ? [moduleStep(b, 'perps')] : []),
      {
        t: `${add ? 'Add' : 'Remove'} ${amount}`,
        d: add ? 'From your vault balance' : 'Back to your vault balance',
        label: add ? 'Add margin' : 'Remove margin',
        waitFor: add ? undefined : ['StalePrice', 'PriceLagging'],
        call: () => ({ address: perps, abi: PERPS_ABI, functionName: add ? 'addMargin' : 'removeMargin', args: [pos.id, units] }),
      },
    ],
    done: () => ({ rows: [['Position', `#${pos.id}`], [add ? 'Added' : 'Removed', amount], ['Margin now', usdg(b, after)]], toast: add ? 'Margin added' : 'Margin removed' }),
    ...b,
    d: b.oc.d,
  };
}

export function forcedExitFlow(b: FlowBase, pos: ChainPosition): TxFlowSpec {
  const perps = b.oc.d.contracts.perpsMarkets as A;
  const days = Number(b.proto.exitDelay / 86_400n);
  const bond = exact(b.proto.bond, 18, 'ETH');
  return {
    title: 'Request a forced exit',
    review: [
      ['Position', `#${pos.id} ${pos.sym} ${pos.long ? 'long' : 'short'}`],
      ['Bond', `${bond} (claimable with "Claim bond refund" once the position closes)`],
      ['Settles', `After ${days} days, by anyone`],
    ],
    note:
      pos.role === 'taker'
        ? 'The escape hatch if the services go quiet: after the delay anyone can settle it, at the price of a plain close (close spread and fee). You can still close normally at any time.'
        : 'As the maker you cannot close a position yourself; a forced exit lets you leave after the delay, at the oracle price with no spread or fee.',
    steps: [
      {
        t: 'Requesting the forced exit',
        d: `With the ${bond} bond`,
        label: 'Forced exit request',
        call: () => ({ address: perps, abi: PERPS_ABI, functionName: 'requestForcedExit', args: [pos.id], value: b.proto.bond }),
        after: (r, ctx) => {
          const ev = events(PERPS_ABI, r).find((e) => e.eventName === 'ForcedExitRequested');
          ctx.out.settleAfter = big(ev?.args.settleAfter);
        },
      },
    ],
    done: (ctx) => ({
      rows: [
        ['Position', `#${pos.id}`],
        ['Bond', bond],
        ['Can settle from', ctx.out.settleAfter ? new Date(Number(big(ctx.out.settleAfter)) * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : `In ${days} days`],
      ],
      toast: 'Forced exit requested',
    }),
    ...b,
    d: b.oc.d,
  };
}

export function settleExitFlow(b: FlowBase, pos: ChainPosition): TxFlowSpec {
  const perps = b.oc.d.contracts.perpsMarkets as A;
  return {
    title: 'Settle the forced exit',
    review: [['Position', `#${pos.id} ${pos.sym} ${pos.long ? 'long' : 'short'}`], ['Price', 'The oracle price now (at most 10 seconds old)']],
    steps: [
      {
        t: 'Settling the forced exit',
        d: 'The bond is refunded to the requester',
        label: 'Settlement',
        waitFor: ['StalePrice', 'PriceLagging'],
        call: () => ({ address: perps, abi: PERPS_ABI, functionName: 'settleForcedExit', args: [pos.id] }),
        after: (r, ctx) => {
          const s = events(PERPS_ABI, r).find((e) => e.eventName === 'PositionSettled');
          ctx.out.out = big(s?.args.takerOut);
          ctx.out.makerOut = big(s?.args.makerOut);
        },
      },
    ],
    done: (ctx) => ({ rows: [['Position', `#${pos.id}`], [pos.role === 'taker' ? 'Returned' : 'Returned to you', usdg(b, pos.role === 'taker' ? big(ctx.out.out) : big(ctx.out.makerOut))]], toast: 'Forced exit settled' }),
    ...b,
    d: b.oc.d,
  };
}

export function claimBondFlow(b: FlowBase, amount: bigint): TxFlowSpec {
  const perps = b.oc.d.contracts.perpsMarkets as A;
  return {
    title: 'Claim your forced-exit bond',
    review: [['Bond refund', exact(amount, 18, 'ETH')]],
    steps: [{ t: 'Claiming the bond', label: 'Bond claim', call: () => ({ address: perps, abi: PERPS_ABI, functionName: 'claimBond', args: [] }) }],
    done: () => ({ rows: [['Claimed', exact(amount, 18, 'ETH')]], toast: 'Bond claimed' }),
    ...b,
    d: b.oc.d,
  };
}

/* ---------------------------------------------------------------- spot */

export interface SwapInput {
  from: string;
  to: string;
  amountIn: bigint;
  quote: bigint;
  min: bigint;
  hops: 1 | 2;
  slip: bigint;
  /** Fee rows already formatted (e.g. "0.30 USDG", "0.003 TSLA + 0.70 USDG"). */
  fee: string;
  title?: string;
  toast?: string;
}

export function swapFlow(b: FlowBase, i: SwapInput): TxFlowSpec {
  const sp = b.oc.d.contracts.spotPools as A;
  const dIn = dec(b, i.from);
  const dOut = dec(b, i.to);
  return {
    title: i.title ?? `Swap ${i.from} for ${i.to}`,
    review: [
      ['You pay', exact(i.amountIn, dIn, i.from)],
      ['You get (est.)', `${approx(i.quote, dOut, 4)} ${i.to}`],
      ['Minimum you get', `${exact(i.min, dOut, i.to)} (${Number(i.slip) / 100}% slippage)`],
      [i.hops === 2 ? 'Pool fees (2 pools)' : 'Pool fee (0.30%)', i.fee],
      ['Route', i.hops === 2 ? `${i.from} → USDG → ${i.to}` : `${i.from} → ${i.to}`],
    ],
    note: 'Phase 3: pools are public, so this swap and its amounts are visible onchain. The minimum protects you if the price moves.',
    steps: [
      moduleStep(b, 'spot'),
      {
        t: i.hops === 2 ? 'Swapping through both pools in one transaction' : `Swapping through the ${i.from === 'USDG' ? i.to : i.from} pool`,
        d: `Only at or above ${exact(i.min, dOut, i.to)}`,
        label: 'Swap',
        outToken: b.oc.d.tokens[i.to],
        call: async () => ({ address: sp, abi: SPOT_ABI, functionName: 'swap', args: [token(b, i.from), token(b, i.to), i.amountIn, i.min, await deadline()] }),
        after: (r, ctx) => {
          const ev = events(SPOT_ABI, r).find((e) => e.eventName === 'Swapped');
          ctx.out.got = big(ev?.args.amountOut);
        },
      },
    ],
    done: (ctx) => ({
      rows: [
        ['You paid', exact(i.amountIn, dIn, i.from)],
        ['You got', exact(big(ctx.out.got), dOut, i.to)],
        [i.hops === 2 ? 'Pool fees' : 'Pool fee', i.fee],
      ],
      toast: i.toast ?? 'Swapped',
    }),
    ...b,
    d: b.oc.d,
  };
}

export interface LpAddInput {
  sym: string;
  /** USDG to add in value (base units); half is swapped into the stock when the pool has liquidity. */
  usdgUnits: bigint;
  pool: PoolState;
  /** Stock and USDG for a first deposit (empty pool): both from the vault, at the oracle price. */
  first: { stock: bigint; usdg: bigint } | null;
  /** Expected stock from swapping half (non-empty pool). */
  swapQuote: bigint;
  slip: bigint;
}

export function lpAddFlow(b: FlowBase, i: LpAddInput): TxFlowSpec {
  const sp = b.oc.d.contracts.spotPools as A;
  const sd = dec(b, i.sym);
  const half = i.usdgUnits / 2n;
  const stockTok = token(b, i.sym);
  const steps: TxStepSpec[] = [moduleStep(b, 'spot')];
  const review: Row[] = [['Pool', `${i.sym} / USDG`]];
  if (i.first) {
    const shares = sharesFor(i.pool, i.first.stock, i.first.usdg);
    review.push(['Add', `${exact(i.first.usdg, dec(b, 'USDG'), 'USDG')} and ${exact(i.first.stock, sd, i.sym)}`], ['Starting price', 'The oracle price now (first deposit sets it)']);
    steps.push({
      t: `Adding ${i.sym} and USDG`,
      d: 'The first deposit sets the pool price',
      label: 'Add liquidity',
      call: async () => ({ address: sp, abi: SPOT_ABI, functionName: 'addLiquidity', args: [stockTok, i.first!.stock, i.first!.usdg, shares, await deadline()] }),
      after: (r, ctx) => {
        const ev = events(SPOT_ABI, r).find((e) => e.eventName === 'LiquidityAdded');
        ctx.out.shares = big(ev?.args.shares);
        ctx.out.usdgIn = big(ev?.args.usdgAmount);
        ctx.out.stockIn = big(ev?.args.stockAmount);
      },
    });
  } else {
    const min1 = minOut(i.swapQuote, i.slip);
    review.push(
      ['Swapped into ' + i.sym, `${exact(half, dec(b, 'USDG'), 'USDG')} → at least ${exact(min1, sd, i.sym)}`],
      ['Added as USDG', `Up to ${exact(i.usdgUnits - half, dec(b, 'USDG'), 'USDG')}`],
      ['Slippage', `${Number(i.slip) / 100}% on the swap and on the shares`],
    );
    steps.push(
      {
        t: `Swapping half into ${i.sym}`,
        d: `Only at or above ${exact(min1, sd, i.sym)}`,
        label: 'Swap',
        outToken: stockTok,
        call: async () => ({ address: sp, abi: SPOT_ABI, functionName: 'swap', args: [token(b, 'USDG'), stockTok, half, min1, await deadline()] }),
        after: (r, ctx) => {
          ctx.out.stockGot = big(events(SPOT_ABI, r).find((e) => e.eventName === 'Swapped')?.args.amountOut);
        },
      },
      {
        t: 'Adding both to the pool',
        d: 'Only the amounts matching the pool ratio are taken; the rest stays in your vault',
        label: 'Add liquidity',
        call: async (ctx: TxRunCtx) => {
          const stockGot = big(ctx.out.stockGot);
          const [sr, ur, ts] = await publicClient.readContract({ address: sp, abi: SPOT_ABI, functionName: 'pools', args: [stockTok] });
          const shares = sharesFor({ stockReserve: sr, usdgReserve: ur, totalShares: ts }, stockGot, i.usdgUnits - half);
          const min = minOut(shares, i.slip);
          return { address: sp, abi: SPOT_ABI, functionName: 'addLiquidity', args: [stockTok, stockGot, i.usdgUnits - half, min > 0n ? min : 1n, await deadline()] };
        },
        after: (r, ctx) => {
          const ev = events(SPOT_ABI, r).find((e) => e.eventName === 'LiquidityAdded');
          ctx.out.shares = big(ev?.args.shares);
          ctx.out.usdgIn = big(ev?.args.usdgAmount);
          ctx.out.stockIn = big(ev?.args.stockAmount);
        },
      },
    );
  }
  return {
    title: `Add liquidity to ${i.sym}`,
    review,
    note: 'Phase 3: pools and your share are public onchain. You earn 0.30% of every swap through the pool.',
    steps,
    done: (ctx) => ({
      rows: [
        ['Pool', `${i.sym} / USDG`],
        ['Added', `${exact(big(ctx.out.usdgIn), dec(b, 'USDG'), 'USDG')} and ${approx(big(ctx.out.stockIn), sd, 4)} ${i.sym}`],
        ['Pool shares', big(ctx.out.shares).toString()],
      ],
      toast: 'Liquidity added',
    }),
    ...b,
    d: b.oc.d,
  };
}

export function lpRemoveFlow(b: FlowBase, sym: string, shares: bigint, pool: PoolState, slip: bigint): TxFlowSpec {
  const sp = b.oc.d.contracts.spotPools as A;
  const q = removeQuote(pool, shares);
  const minS = minOut(q.stock, slip);
  const minU = minOut(q.usdg, slip);
  const sd = dec(b, sym);
  const ud = dec(b, 'USDG');
  return {
    title: `Remove liquidity from ${sym}`,
    review: [
      ['Pool shares', shares.toString()],
      ['You get (est.)', `${approx(q.stock, sd, 4)} ${sym} and ${approx(q.usdg, ud)} USDG`],
      ['Minimum', `${exact(minS > 0n ? minS : 1n, sd, sym)} and ${exact(minU > 0n ? minU : 1n, ud, 'USDG')} (${Number(slip) / 100}% slippage)`],
    ],
    steps: [
      {
        t: 'Returning your share',
        d: `As ${sym} and USDG to your vault balance`,
        label: 'Remove liquidity',
        call: async () => ({ address: sp, abi: SPOT_ABI, functionName: 'removeLiquidity', args: [token(b, sym), shares, minS > 0n ? minS : 1n, minU > 0n ? minU : 1n, await deadline()] }),
        after: (r, ctx) => {
          const ev = events(SPOT_ABI, r).find((e) => e.eventName === 'LiquidityRemoved');
          ctx.out.stock = big(ev?.args.stockAmount);
          ctx.out.usdg = big(ev?.args.usdgAmount);
        },
      },
    ],
    done: (ctx) => ({ rows: [['Returned', `${exact(big(ctx.out.stock), sd, sym)} and ${exact(big(ctx.out.usdg), ud, 'USDG')}`]], toast: 'Liquidity removed' }),
    ...b,
    d: b.oc.d,
  };
}

/* ---------------------------------------------------------------- maker book */

export interface OfferInputOnchain {
  sym: string;
  backing: bigint;
  largestFill: bigint;
  openBps: number;
  closeBps: number;
  /** Offer duration in seconds (added to the latest block time). */
  duration: bigint;
  durationLabel: string;
}

export function postOfferFlow(b: FlowBase, i: OfferInputOnchain): TxFlowSpec {
  const book = b.oc.d.contracts.makerBook as A;
  return {
    title: `Post ${i.sym} offer`,
    review: [
      ['Market', `${i.sym} perp`],
      ['Backing', usdg(b, i.backing)],
      ['Largest single fill', usdg(b, i.largestFill)],
      ['Spreads', `${i.openBps} / ${i.closeBps} bps`],
      ['Exposure', `Up to 5 × backing (${usdg(b, i.backing * 5n)} of positions)`],
      ['Ends in', i.durationLabel],
    ],
    note: 'Backing is your margin, not a cap on exposure: each fill takes 20% of its size from the backing. Your offer and every fill are public onchain in this phase.',
    steps: [
      moduleStep(b, 'book'),
      {
        t: 'Posting the offer',
        d: `${usdg(b, i.backing)} backing locked`,
        label: 'Post offer',
        call: async () => ({ address: book, abi: BOOK_ABI, functionName: 'postOffer', args: [token(b, i.sym), i.backing, i.largestFill, i.openBps, i.closeBps, (await publicClient.getBlock({ blockTag: 'latest' })).timestamp + i.duration] }),
        after: (r, ctx) => {
          ctx.out.id = big(events(BOOK_ABI, r).find((e) => e.eventName === 'OfferPosted')?.args.id);
        },
      },
    ],
    done: (ctx) => ({
      rows: [
        ['Market', `${i.sym} perp`],
        ['Backing', usdg(b, i.backing)],
        ['Spreads', `${i.openBps} / ${i.closeBps} bps`],
        ['Ends in', i.durationLabel],
        ['Offer ID', `#${String(ctx.out.id ?? '')}`],
      ],
      toast: 'Offer posted',
    }),
    ...b,
    d: b.oc.d,
  };
}

export function withdrawOfferFlow(b: FlowBase, o: Offer, sym: string): TxFlowSpec {
  const book = b.oc.d.contracts.makerBook as A;
  return {
    title: `Withdraw ${sym} offer`,
    review: [['Offer', `#${o.id}`], ['Unused backing returned', usdg(b, o.backing)]],
    note: 'Positions already filled from this offer stay open; their margin is not part of the unused backing.',
    steps: [
      {
        t: 'Releasing unused backing',
        d: 'Back to your vault balance',
        label: 'Withdraw offer',
        call: () => ({ address: book, abi: BOOK_ABI, functionName: 'withdrawOffer', args: [o.id] }),
        after: (r, ctx) => {
          ctx.out.returned = big(events(BOOK_ABI, r).find((e) => e.eventName === 'OfferWithdrawn')?.args.returned);
        },
      },
    ],
    done: (ctx) => ({ rows: [['Returned', usdg(b, big(ctx.out.returned))]], toast: 'Offer withdrawn' }),
    ...b,
    d: b.oc.d,
  };
}

export { openLimit };
