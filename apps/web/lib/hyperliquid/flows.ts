'use client';
/**
 * Real perps flows on Hyperliquid's xyz dex, in the shape of the app's other flows (review, steps with live states,
 * receipt), run by components/hyperliquid/HlFlowModal.tsx. Nothing is signed before the review is confirmed; every step
 * re-reads what it needs and is skipped when already done (an approved agent, the leverage already set, enough margin).
 *
 *  open:  enable trading (the user's wallet approves a browser-held agent, once per 30 days) -> move margin into the
 *         stock perps balance (standard accounts only) -> isolated leverage -> IOC order at the reviewed limit price.
 *  close: (enable trading if needed) -> reduce-only IOC order for the whole position.
 *
 * An IOC order that cannot fill within the limit is cancelled by Hyperliquid: nothing is traded and the step says so.
 */
import { HL_DEX, HL_MAX_LEVERAGE, type HlMarket } from '@velum/config/src/hyperliquid';
import type { ReactNode } from 'react';
import { isUserRejection } from '../onchain/errors';
import { agentListed, clearAgent, loadAgent, type StoredAgent } from './agent';
import { BUILDER, agentClient, approveBuilder, approveNewAgent, builderApproved, builderRate, freshAsset, info, moveToXyz, type HlMode } from './client';
import { orderOutcome, orderParams, type Builder, type ClosePlan, type OpenPlan } from './order';

export type Row = [ReactNode, ReactNode];

export interface HlCtx {
  user: `0x${string}`;
  agent: StoredAgent | null;
  out: Record<string, unknown>;
}

export interface HlStep {
  t: string;
  d?: string;
  /** The step may ask the user's wallet to sign (said while it runs). */
  wallet?: boolean;
  /** What the dialog says while the step runs, when neither the wallet line nor "Sending to Hyperliquid" fits. */
  active?: string;
  /** Runs the step; returns the line shown when done, or null when it was not needed (shown as "Already done"). */
  run: (ctx: HlCtx) => Promise<string | null>;
}

export interface HlFlowSpec {
  title: string;
  review: Row[];
  note?: string;
  ack?: string;
  confirmLabel?: string;
  steps: HlStep[];
  done: (ctx: HlCtx) => { rows: Row[]; toast: string };
  user: `0x${string}`;
}

/** One plain sentence for anything a Hyperliquid step can throw. */
export function hlErrorText(e: unknown): string {
  if (isUserRejection(e)) return 'You declined the request in your wallet. Nothing was sent.';
  const msg = String((e as { message?: unknown })?.message ?? e ?? '');
  if (/Must deposit before performing actions/i.test(msg)) return 'Your Hyperliquid account has no deposit yet. Deposit USDC on Hyperliquid first, then come back.';
  if (/could not immediately match|no resting orders|IocCancel/i.test(msg)) return 'The price moved past your slippage limit, so the order was cancelled and nothing was traded. Try again, or allow more slippage.';
  if (/Insufficient margin/i.test(msg)) return 'Not enough margin in your Hyperliquid account for this order. Deposit more USDC or lower the size.';
  if (/minimum value of \$10/i.test(msg)) return 'Hyperliquid accepts orders of at least 10 USD.';
  if (/does not exist|not approved|agent/i.test(msg) && /wallet|agent/i.test(msg)) return 'This browser is no longer approved to trade for your account. Start again to approve it.';
  if (/switched to another account/i.test(msg)) return msg;
  if (/insufficient funds for (gas|intrinsic)|gas required exceeds/i.test(msg)) return 'Your wallet needs a little ETH on Arbitrum to pay the gas. Nothing was sent.';
  if (/transfer amount exceeds balance/i.test(msg)) return 'Not enough USDC on Arbitrum for this deposit. Nothing was sent.';
  if (/Nothing was sent|credited|Arbiscan|not shown the deposit/i.test(msg)) return msg;
  const short = msg.replace(/^order \d+: /, '').split('\n')[0]!.slice(0, 200);
  return short ? `Hyperliquid refused the request: ${short}` : 'Hyperliquid did not answer. Nothing was traded; try again.';
}

/** Step: make sure this browser holds an agent Hyperliquid still lists for the user, approving a fresh one if needed. */
export function enableStep(): HlStep {
  return {
    t: 'Enable trading on Hyperliquid',
    wallet: true,
    d: 'Your wallet signs once (no gas) to let this browser place orders for you for 30 days. It cannot withdraw.',
    run: async (ctx) => {
      const have = loadAgent(ctx.user);
      if (have && agentListed(await info.extraAgents({ user: ctx.user }), have.address)) {
        ctx.agent = have;
        return null;
      }
      if (have) clearAgent(ctx.user);
      ctx.agent = await approveNewAgent(ctx.user);
      return 'Approved in your wallet';
    },
  };
}

/** Step (only when the build sets a builder fee): the user's wallet allows Velum's fee once; skipped when already allowed. */
export function builderStep(b: Builder): HlStep {
  return {
    t: "Allow Velum's fee",
    wallet: true,
    d: `Your wallet signs once (no gas) to allow Velum's ${builderRate(b.f)} fee on orders placed here.`,
    run: async (ctx) => {
      if (await builderApproved(ctx.user, b)) return null;
      await approveBuilder(ctx.user, b);
      return 'Approved in your wallet';
    },
  };
}

/** The steps every flow starts with: this browser's agent, then (if any) the builder fee approval. */
const firstSteps = (): HlStep[] => (BUILDER ? [enableStep(), builderStep(BUILDER)] : [enableStep()]);

const need = (ctx: HlCtx): StoredAgent => {
  if (!ctx.agent) throw new Error('This browser is not approved to trade yet.');
  return ctx.agent;
};

export interface OpenInput {
  user: `0x${string}`;
  sym: string;
  market: HlMarket;
  plan: OpenPlan;
  mode: HlMode;
  /** USDC usable for xyz positions now, and (standard accounts) movable from the main balance. */
  xyzAvailable: number;
  mainAvailable: number;
  slipPct: number;
  /** Shown in the review: estimated liquidation price, or null. */
  liqEst: string | null;
}

const cents = (n: number): string => (Math.ceil(n * 100) / 100).toFixed(2);

/** Opening (or adding to) a long or short position. */
export function openFlow(p: OpenInput): HlFlowSpec {
  const side = p.plan.isBuy ? 'Long' : 'Short';
  const margin = Number(p.plan.margin);
  const steps: HlStep[] = firstSteps();
  if (p.mode === 'standard') {
    steps.push({
      t: 'Move margin to your stock perps balance',
      d: 'Within your Hyperliquid account: from the main USDC balance to the XYZ stock market balance',
      run: async (ctx) => {
        const st = await info.clearinghouseState({ user: ctx.user, dex: HL_DEX });
        const shortfall = margin - Number(st.withdrawable);
        if (!(shortfall > 0)) return null;
        const amount = cents(shortfall);
        await moveToXyz(need(ctx), amount);
        return `Moved ${amount} USDC`;
      },
    });
  }
  steps.push({
    t: `Set ${p.plan.leverage}x isolated leverage`,
    d: 'Your margin for this market is its own: a loss never reaches the rest of your account',
    run: async (ctx) => {
      const a = await freshAsset(ctx.user, p.market.coin);
      if (a.leverage.type === 'isolated' && a.leverage.value === p.plan.leverage) return null;
      if (p.plan.leverage < 1 || p.plan.leverage > HL_MAX_LEVERAGE) throw new Error('leverage out of range');
      await agentClient(need(ctx)).updateLeverage({ asset: p.market.asset, isCross: false, leverage: p.plan.leverage });
      return `${p.plan.leverage}x isolated`;
    },
  });
  steps.push({
    t: `${side} ${p.plan.size} ${p.sym}`,
    d: `An immediate order at most ${p.plan.limitPx} USDC per token (${p.plan.isBuy ? 'buy' : 'sell'}); cancelled if it cannot fill`,
    run: async (ctx) => {
      const res = await agentClient(need(ctx)).order(orderParams({ ...p.plan, reduceOnly: false }, BUILDER));
      const o = orderOutcome(res);
      if (o.kind === 'error') throw new Error(o.message);
      if (o.kind === 'resting') throw new Error('The order did not fill immediately.');
      ctx.out.filled = o;
      return `Filled ${o.totalSz} ${p.sym} at ${o.avgPx}`;
    },
  });
  return {
    title: `${side} ${p.sym} on Hyperliquid`,
    review: [
      ['Side', side],
      ['Size', `${p.plan.size} ${p.sym} (about ${p.plan.notional} USD)`],
      ['Leverage', `${p.plan.leverage}x isolated`],
      ['Margin', `${p.plan.margin} USDC`],
      ['Price limit', `${p.plan.isBuy ? 'At most' : 'At least'} ${p.plan.limitPx} (${p.slipPct}% slippage)`],
      ['Liquidation (est.)', p.liqEst ?? '—'],
      ['Market', `${p.market.coin} on Hyperliquid`],
      ['Fees', BUILDER ? `Hyperliquid's trading fee, plus Velum's ${builderRate(BUILDER.f)}` : "Hyperliquid's trading fee; Velum adds none"],
    ],
    note:
      'A real perps order from your own Hyperliquid account, routed through Hyperliquid (trade.xyz market). Funding is paid hourly and the position can be liquidated. Public on Hyperliquid, not private.' +
      (p.mode === 'standard' && p.xyzAvailable < margin ? ` ${cents(margin - p.xyzAvailable)} USDC moves from your main Hyperliquid balance to the stock market balance first.` : ''),
    ack: 'I understand this is a real leveraged trade with real money on Hyperliquid, and that I can lose my margin.',
    confirmLabel: 'Start trade',
    steps,
    done: (ctx) => {
      const f = ctx.out.filled as { totalSz: string; avgPx: string; oid: number } | undefined;
      return {
        rows: [
          ['Side', side],
          ['Filled', f ? `${f.totalSz} ${p.sym}` : '—'],
          ['Average price', f ? `${f.avgPx} USDC` : '—'],
          ['Leverage', `${p.plan.leverage}x isolated`],
          ['Order', f ? `#${f.oid} on Hyperliquid` : '—'],
        ],
        toast: `${side} ${p.sym} opened`,
      };
    },
    user: p.user,
  };
}

/** Closing a whole position. */
export function closeFlow(p: { user: `0x${string}`; sym: string; plan: ClosePlan; slipPct: number; pnl: string }): HlFlowSpec {
  return {
    title: `Close ${p.sym} on Hyperliquid`,
    review: [
      ['Position', `${p.plan.isBuy ? 'Short' : 'Long'} ${p.plan.size} ${p.sym}`],
      ['Price limit', `${p.plan.isBuy ? 'At most' : 'At least'} ${p.plan.limitPx} (${p.slipPct}% slippage)`],
      ['Unrealized P&L', `${p.pnl} USDC`],
    ],
    note: 'A reduce-only order for the whole position on Hyperliquid; it can only close, never open the other way.',
    confirmLabel: 'Close position',
    steps: [
      ...firstSteps(),
      {
        t: `Close ${p.plan.size} ${p.sym}`,
        d: 'An immediate reduce-only order; cancelled if it cannot fill within your limit',
        run: async (ctx) => {
          const res = await agentClient(need(ctx)).order(orderParams({ ...p.plan, reduceOnly: true }, BUILDER));
          const o = orderOutcome(res);
          if (o.kind === 'error') throw new Error(o.message);
          if (o.kind === 'resting') throw new Error('The order did not fill immediately.');
          ctx.out.filled = o;
          return `Closed ${o.totalSz} ${p.sym} at ${o.avgPx}`;
        },
      },
    ],
    done: (ctx) => {
      const f = ctx.out.filled as { totalSz: string; avgPx: string; oid: number } | undefined;
      return { rows: [['Closed', f ? `${f.totalSz} ${p.sym}` : '—'], ['Average price', f ? `${f.avgPx} USDC` : '—']], toast: `${p.sym} position closed` };
    },
    user: p.user,
  };
}
