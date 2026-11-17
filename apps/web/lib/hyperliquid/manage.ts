'use client';
/**
 * Managing real perps positions and orders on Hyperliquid's xyz dex, in the app's flow shape (review, steps, receipt;
 * components/hyperliquid/HlFlowModal.tsx). Everything here is signed by the browser's agent (approved once by the
 * user's wallet, lib/hyperliquid/flows.ts enableStep): orders, cancels and margin moves between the user's own balances,
 * never a withdrawal.
 *
 *  tpsl:    set or replace a position's take profit and stop loss (positionTpsl: the size follows the position);
 *  close:   close a share of a position (reduce-only immediate order);
 *  margin:  add margin to an isolated position (from the stock perps balance, topped up from the main balance on standard
 *           accounts) or remove some;
 *  cancel:  cancel open orders (limit, take profit, stop loss).
 */
import { HL_DEX, type HlMarket } from '@velum/config/src/hyperliquid';
import { useQuery } from '@tanstack/react-query';
import { BUILDER, agentClient, info, moveToXyz, type HlMode } from './client';
import { enableStep, type HlCtx, type HlFlowSpec, type HlStep } from './flows';
import { orderOutcome, orderParams } from './order';
import { KIND_LABEL, readOpenOrders, tpslEntries, type OpenOrder, type PartialClose, type TpslOrder } from './risk';

/** The user's open orders in the Velum markets (frontendOpenOrders on the xyz dex, weight 20) every 10 s. */
export function useHlOpenOrders(user: `0x${string}` | undefined) {
  return useQuery({
    queryKey: ['hl-orders', user],
    enabled: !!user,
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: 1,
    queryFn: async () => readOpenOrders(await info.frontendOpenOrders({ user: user!, dex: HL_DEX })),
  });
}

const need = (ctx: HlCtx) => {
  if (!ctx.agent) throw new Error('This browser is not approved to trade yet.');
  return ctx.agent;
};

/** Reads a cancel answer: every status must be "success". */
function cancelled(res: unknown): void {
  const statuses = (res as { response?: { data?: { statuses?: unknown[] } } } | null)?.response?.data?.statuses ?? [];
  const bad = statuses.find((s) => s !== 'success');
  if (bad !== undefined) throw new Error(typeof bad === 'object' && bad && 'error' in bad ? String((bad as { error: unknown }).error) : 'The exchange did not cancel the order.');
}

/** Reads a multi-order answer: no status may be an error. */
function placed(res: unknown): number {
  const statuses = (res as { response?: { data?: { statuses?: unknown[] } } } | null)?.response?.data?.statuses ?? [];
  if (!statuses.length) throw new Error('The exchange answered without an order status.');
  for (const s of statuses) if (s && typeof s === 'object' && 'error' in s) throw new Error(String((s as { error: unknown }).error));
  return statuses.length;
}

const tpslRow = (t: TpslOrder, sym: string) => `${t.kind === 'tp' ? 'Take profit' : 'Stop loss'} at ${t.triggerPx} (P&L about ${t.pnl.startsWith('-') ? '-$' + t.pnl.slice(1) : '+$' + t.pnl}; fills at worst ${t.limitPx}, ${sym})`;

/** Step: places TP/SL triggers on the whole position (positionTpsl), cancelling the ones they replace first. */
export function tpslStep(p: { market: HlMarket; long: boolean; size: string; orders: TpslOrder[]; replace: number[] }): HlStep {
  return {
    t: p.orders.length === 2 ? 'Set take profit and stop loss' : p.orders[0]!.kind === 'tp' ? 'Set take profit' : 'Set stop loss',
    d: 'Trigger orders that close the position at your prices; they follow its size',
    run: async (ctx) => {
      const ex = agentClient(need(ctx));
      if (p.replace.length && !ctx.out.replaced) {
        cancelled(await ex.cancel({ cancels: p.replace.map((o) => ({ a: p.market.asset, o })) }));
        ctx.out.replaced = true;
      }
      placed(await ex.order({ orders: tpslEntries({ asset: p.market.asset, long: p.long, size: p.size, orders: p.orders }), grouping: 'positionTpsl', ...(BUILDER ? { builder: BUILDER } : {}) }));
      return p.orders.map((o) => `${o.kind === 'tp' ? 'TP' : 'SL'} ${o.triggerPx}`).join(' · ');
    },
  };
}

/** Setting or replacing a position's take profit and stop loss. */
export function tpslFlow(p: { user: `0x${string}`; sym: string; market: HlMarket; long: boolean; size: string; orders: TpslOrder[]; replace: OpenOrder[] }): HlFlowSpec {
  return {
    title: `TP/SL for ${p.sym}`,
    review: [
      ['Position', `${p.long ? 'Long' : 'Short'} ${p.size} ${p.sym}`],
      ...p.orders.map((t): [string, string] => [t.kind === 'tp' ? 'Take profit' : 'Stop loss', tpslRow(t, p.sym)]),
      ...(p.replace.length ? ([['Replaces', p.replace.map((o) => `${KIND_LABEL[o.kind]} at ${o.px}`).join(', ')]] as Array<[string, string]>) : []),
    ],
    note: 'Reduce-only trigger orders: when the price reaches a trigger, a market order closes the position. They can only close, never open the other way, and they follow the position as it grows or shrinks.',
    confirmLabel: 'Set TP/SL',
    footer: 'Signed in this browser (no wallet prompt once trading is enabled). The trading key can never withdraw your funds.',
    failToast: 'TP/SL not set',
    steps: [enableStep(), tpslStep({ market: p.market, long: p.long, size: p.size, orders: p.orders, replace: p.replace.map((o) => o.oid) })],
    done: () => ({ rows: p.orders.map((t): [string, string] => [t.kind === 'tp' ? 'Take profit' : 'Stop loss', `at ${t.triggerPx}`]), toast: `TP/SL set for ${p.sym}` }),
    user: p.user,
  };
}

/** Closing a share (or all) of a position. */
export function partialCloseFlow(p: { user: `0x${string}`; sym: string; plan: PartialClose; slipPct: number; pnl: string }): HlFlowSpec {
  const what = p.plan.pct === 100 ? 'the whole position' : `${p.plan.pct}% of the position`;
  return {
    title: p.plan.pct === 100 ? `Close ${p.sym}` : `Close ${p.plan.pct}% of ${p.sym}`,
    review: [
      ['Close', `${p.plan.size} ${p.sym} (${what}, about ${p.plan.notional} USD)`],
      ['Price limit', `${p.plan.isBuy ? 'At most' : 'At least'} ${p.plan.limitPx} (${p.slipPct}% slippage)`],
      ['Unrealized P&L now', `${p.pnl} USDC (whole position)`],
    ],
    note: 'A reduce-only order: it can only close, never open the other way. Any take profit or stop loss on the position stays and follows what is left.',
    confirmLabel: p.plan.pct === 100 ? 'Close position' : `Close ${p.plan.pct}%`,
    failToast: 'Position not closed',
    steps: [
      enableStep(),
      {
        t: `Close ${p.plan.size} ${p.sym}`,
        d: 'An immediate reduce-only order; cancelled if it cannot fill within your limit',
        run: async (ctx) => {
          const o = orderOutcome(await agentClient(need(ctx)).order(orderParams({ ...p.plan, reduceOnly: true }, BUILDER)));
          if (o.kind === 'error') throw new Error(o.message);
          if (o.kind === 'resting') throw new Error('The order did not fill immediately.');
          ctx.out.filled = o;
          return `Closed ${o.totalSz} ${p.sym} at ${o.avgPx}`;
        },
      },
    ],
    done: (ctx) => {
      const f = ctx.out.filled as { totalSz: string; avgPx: string } | undefined;
      return { rows: [['Closed', f ? `${f.totalSz} ${p.sym}` : '—'], ['Average price', f ? `${f.avgPx} USDC` : '—']], toast: p.plan.pct === 100 ? `${p.sym} position closed` : `Closed ${p.plan.pct}% of ${p.sym}` };
    },
    user: p.user,
  };
}

/** Adding margin to (ntli > 0) or removing it from (ntli < 0) an isolated position. */
export function marginFlow(p: { user: `0x${string}`; sym: string; market: HlMarket; long: boolean; ntli: number; mode: HlMode; liqNow: string; liqAfter: string }): HlFlowSpec {
  const add = p.ntli > 0;
  const usd = (Math.abs(p.ntli) / 1e6).toFixed(2);
  const steps: HlStep[] = [enableStep()];
  if (add && p.mode === 'standard')
    steps.push({
      t: 'Move USDC to your stock perps balance',
      d: 'Within your perps account, when the stock perps balance lacks it; skipped otherwise',
      run: async (ctx) => {
        const st = await info.clearinghouseState({ user: ctx.user, dex: HL_DEX });
        const shortfall = Math.abs(p.ntli) / 1e6 - Number(st.withdrawable);
        if (!(shortfall > 0)) return null;
        const amount = (Math.ceil(shortfall * 100) / 100).toFixed(2);
        await moveToXyz(need(ctx), amount);
        return `Moved ${amount} USDC`;
      },
    });
  steps.push({
    t: add ? `Add ${usd} USDC of margin` : `Remove ${usd} USDC of margin`,
    d: add ? 'Moves USDC into this position: its liquidation price moves away' : 'Moves USDC out of this position into your balance: its liquidation price moves closer',
    run: async (ctx) => {
      const res = await agentClient(need(ctx)).updateIsolatedMargin({ asset: p.market.asset, isBuy: p.long, ntli: p.ntli });
      const st = (res as { status?: unknown }).status;
      if (st !== undefined && st !== 'ok') throw new Error('The exchange refused the margin change.');
      return add ? `Added ${usd} USDC` : `Removed ${usd} USDC`;
    },
  });
  return {
    title: `${add ? 'Add' : 'Remove'} margin · ${p.sym}`,
    review: [
      ['Position', `${p.long ? 'Long' : 'Short'} ${p.sym}, isolated`],
      [add ? 'Add' : 'Remove', `${usd} USDC`],
      ['Liquidation price', `${p.liqNow} → about ${p.liqAfter}`],
    ],
    note: add ? 'More margin keeps the position further from liquidation. The leverage shown on the position is its setting; the effective leverage falls.' : 'Less margin brings the liquidation price closer. The exchange refuses to remove more than the position needs.',
    confirmLabel: add ? 'Add margin' : 'Remove margin',
    failToast: 'Margin not changed',
    steps,
    done: () => ({ rows: [[add ? 'Added' : 'Removed', `${usd} USDC`], ['Liquidation price (est.)', p.liqAfter]], toast: `Margin ${add ? 'added to' : 'removed from'} ${p.sym}` }),
    user: p.user,
  };
}

/** Cancelling open orders. */
export function cancelFlow(p: { user: `0x${string}`; orders: OpenOrder[] }): HlFlowSpec {
  const one = p.orders.length === 1;
  const line = (o: OpenOrder) => `${KIND_LABEL[o.kind]} ${o.isBuy ? 'buy' : 'sell'} ${o.sz === '0.0' || o.sz === '0' ? '' : `${o.sz} `}${o.symbol} at ${o.px}`;
  return {
    title: one ? 'Cancel order' : `Cancel ${p.orders.length} orders`,
    review: p.orders.slice(0, 8).map((o, i): [string, string] => [one ? 'Order' : `#${i + 1}`, line(o)]),
    confirmLabel: one ? 'Cancel order' : 'Cancel all',
    failToast: 'Not cancelled',
    steps: [
      enableStep(),
      {
        t: one ? 'Cancel the order' : `Cancel ${p.orders.length} orders`,
        run: async (ctx) => {
          cancelled(await agentClient(need(ctx)).cancel({ cancels: p.orders.map((o) => ({ a: o.asset, o: o.oid })) }));
          return one ? 'Cancelled' : `${p.orders.length} cancelled`;
        },
      },
    ],
    done: () => ({ rows: [['Cancelled', one ? line(p.orders[0]!) : `${p.orders.length} orders`]], toast: one ? 'Order cancelled' : 'Orders cancelled' }),
    user: p.user,
  };
}
