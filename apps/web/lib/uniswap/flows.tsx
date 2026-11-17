'use client';
/**
 * Real spot trades on Robinhood Chain mainnet through Uniswap, from the user's own wallet, as TxFlowSpecs for the flow
 * dialog (components/modals/TxFlow.tsx: review, one step per transaction with real states, receipt).
 *
 * Steps per leg: an exact ERC-20 approval of the input to Permit2 (only if short), an exact Permit2 allowance for the
 * Universal Router that expires in 30 minutes (only if short or expiring), then the swap with the minimum output from
 * the slippage setting and a 20-minute deadline on chain time. Approvals are never unlimited. A trade between two
 * Stock Tokens is two legs through USDG: the second leg spends exactly the USDG the first one paid out (read from its
 * receipt), re-quoted at that moment, and is refused below the minimum the review showed (you then keep the USDG).
 *
 * Receipts are read from the token contracts' Transfer events only: the leg is shown done when the wallet paid exactly
 * the input and received at least the minimum of the output token; anything else fails with ReceiptMismatch.
 */
import { UNISWAP, poolLabel } from '@velum/config/src/uniswap';
import { parseEventLogs, type Address, type TransactionReceipt } from 'viem';
import { publicClient } from '../chain';
import { ERC20_ABI } from '../onchain/abi';
import { ReceiptMismatch, type FlowProto, type FlowTarget, type Row, type TxFlowSpec, type TxRunCtx, type TxStepSpec } from '../onchain/flow';
import { exact } from '../onchain/flows';
import { ERC20_TRANSFER_ABI, PERMIT2_ABI, UNIVERSAL_ROUTER_ABI } from './abi';
import { encodeEthBuy, encodeSwap, type Hop } from './encode';
import type { UniPool } from '@velum/config/src/uniswap';
import { bestQuote, poolsOf } from './quote';

/** Swap deadline: 20 minutes after the latest block (chain time). */
export const SWAP_DEADLINE_S = 1200n;
/** Permit2 allowance lifetime for the router: 30 minutes. */
export const PERMIT2_TTL_S = 1800n;
/** A Permit2 allowance expiring sooner than this is renewed before the swap. */
const PERMIT2_MIN_LEFT_S = 300n;
const MAX_UINT160 = (1n << 160n) - 1n;

type A = `0x${string}`;
const lower = (a: string) => a.toLowerCase() as A;
const chainNow = async (): Promise<bigint> => (await publicClient.getBlock({ blockTag: 'latest' })).timestamp;

/** The flow target for Uniswap trades: mainnet, its curated tokens and their decimals. */
export function uniTarget(): { d: FlowTarget; proto: FlowProto } {
  const cfg = UNISWAP!;
  const tokens: Record<string, A> = { USDG: cfg.usdg.address };
  const decimals: Record<string, number> = { USDG: cfg.usdg.decimals };
  for (const [sym, pools] of Object.entries(cfg.pools)) {
    tokens[sym] = pools[0]!.stock;
    decimals[sym] = cfg.decimals[sym]!;
  }
  return { d: { chainId: cfg.chainId, tokens }, proto: { decimals } };
}

/** Sum of the Transfer events of `token` in a receipt matching `pick`. */
function transfers(r: TransactionReceipt, token: A, pick: (from: string, to: string) => boolean): bigint {
  const logs = r.logs.filter((l) => l.address.toLowerCase() === token);
  let sum = 0n;
  for (const e of parseEventLogs({ abi: ERC20_TRANSFER_ABI, logs }) as unknown as Array<{ eventName: string; args: { from: string; to: string; value: bigint } }>) {
    if (e.eventName === 'Transfer' && pick(e.args.from.toLowerCase(), e.args.to.toLowerCase())) sum += e.args.value;
  }
  return sum;
}

/** The two approval steps for spending `amount(ctx)` of `token` through the Universal Router. */
function approvalSteps(sym: string, token: A, amount: (ctx: TxRunCtx) => bigint, shown: string | null): TxStepSpec[] {
  const cfg = UNISWAP!;
  const permit2 = cfg.contracts.permit2;
  const router = cfg.contracts.universalRouter;
  const what = shown ?? `the ${sym} from the previous step`;
  return [
    {
      t: `Approve ${shown ?? sym} for Permit2`,
      d: `Lets Uniswap's Permit2 contract move exactly ${what} from your wallet, and nothing more`,
      label: `${sym} approval`,
      idempotent: true,
      call: async (ctx) => {
        const units = amount(ctx);
        const have = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [ctx.account, permit2] });
        return have >= units ? null : { address: token, abi: ERC20_ABI, functionName: 'approve', args: [permit2, units] };
      },
      after: (r, ctx) => {
        const logs = r.logs.filter((l) => l.address.toLowerCase() === token);
        const ok = (parseEventLogs({ abi: ERC20_ABI, logs }) as unknown as Array<{ eventName: string; args: Record<string, unknown> }>).some(
          (e) => e.eventName === 'Approval' && lower(String(e.args.owner)) === lower(ctx.account) && lower(String(e.args.spender)) === permit2,
        );
        if (!ok) throw new ReceiptMismatch('Approval');
      },
    },
    {
      t: `Allow the Uniswap router to spend it`,
      d: `A Permit2 allowance of exactly ${what} for the Universal Router, valid for 30 minutes`,
      label: 'Router allowance',
      idempotent: true,
      call: async (ctx) => {
        const units = amount(ctx);
        if (units > MAX_UINT160) throw new Error('amount too large');
        const [[have, expiration], now] = await Promise.all([publicClient.readContract({ address: permit2, abi: PERMIT2_ABI, functionName: 'allowance', args: [ctx.account, token, router] }), chainNow()]);
        if (have >= units && BigInt(expiration) > now + PERMIT2_MIN_LEFT_S) return null;
        return { address: permit2, abi: PERMIT2_ABI, functionName: 'approve', args: [token, router, units, Number(now + PERMIT2_TTL_S)] };
      },
      after: (r, ctx) => {
        const logs = r.logs.filter((l) => l.address.toLowerCase() === permit2);
        const ok = (parseEventLogs({ abi: PERMIT2_ABI, logs }) as unknown as Array<{ eventName: string; args: Record<string, unknown> }>).some(
          (e) => e.eventName === 'Approval' && lower(String(e.args.owner)) === lower(ctx.account) && lower(String(e.args.token)) === token && lower(String(e.args.spender)) === router,
        );
        if (!ok) throw new ReceiptMismatch('Permit2 Approval');
      },
    },
  ];
}

/** The swap step of one leg; `plan` returns the hop, the input and the minimum when the step runs. */
function swapStep(t: string, label: string, plan: (ctx: TxRunCtx) => Promise<{ hop: Hop; amountIn: bigint; minOut: bigint }>, outKey: string): TxStepSpec {
  const router = UNISWAP!.contracts.universalRouter;
  let last: { hop: Hop; amountIn: bigint; minOut: bigint } | null = null;
  return {
    t,
    d: 'Through the Uniswap Universal Router; refused onchain below your minimum',
    label,
    call: async (ctx) => {
      last = await plan(ctx);
      const { commands, inputs } = encodeSwap(last.hop, last.amountIn, last.minOut, ctx.account);
      const deadline = (await chainNow()) + SWAP_DEADLINE_S;
      return { address: router, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [commands, inputs, deadline] };
    },
    after: (r, ctx) => {
      if (!last) throw new ReceiptMismatch('swap plan');
      const me = lower(ctx.account);
      const paid = transfers(r, lower(last.hop.tokenIn), (from) => from === me);
      const got = transfers(r, lower(last.hop.tokenOut), (_from, to) => to === me);
      if (paid !== last.amountIn) throw new ReceiptMismatch('the exact input leaving your wallet');
      if (got <= 0n || got < last.minOut) throw new ReceiptMismatch('at least the minimum arriving in your wallet');
      ctx.out[outKey] = got;
      ctx.out[`${outKey}Hop`] = last.hop;
    },
  };
}

export interface UniTradeInput {
  account: Address;
  from: string;
  to: string;
  amountIn: bigint;
  /** The quoted output (estimate shown in the review). */
  quoteOut: bigint;
  /** The minimum the user accepts (from the slippage setting); every leg's last step enforces it onchain. */
  minOut: bigint;
  /** The first leg's hop and, for two legs, the first leg's own minimum (USDG). */
  first: Hop;
  firstMin: bigint;
  /** Two legs only: the second leg's planned hop (re-quoted when it runs). */
  second?: Hop;
  /** What the dialog title says: Buy TSLA, Sell TSLA, Swap. */
  title: string;
  toast: string;
}

/** A real trade through Uniswap (one or two legs). */
export function uniTradeFlow(p: UniTradeInput): TxFlowSpec {
  const { d, proto } = uniTarget();
  const dec = (s: string) => proto.decimals[s]!;
  const tok = (s: string) => d.tokens[s] as A;
  const amt = (u: bigint, s: string) => exact(u, dec(s), s);
  const two = !!p.second;
  const steps: TxStepSpec[] = [...approvalSteps(p.from, tok(p.from), () => p.amountIn, amt(p.amountIn, p.from))];
  if (!two) {
    steps.push(swapStep(`Swap ${amt(p.amountIn, p.from)} for ${p.to}`, 'Swap', async () => ({ hop: p.first, amountIn: p.amountIn, minOut: p.minOut }), 'received'));
  } else {
    steps.push(swapStep(`Sell ${amt(p.amountIn, p.from)} for USDG`, 'Swap 1', async () => ({ hop: p.first, amountIn: p.amountIn, minOut: p.firstMin }), 'usdg'));
    const usdgIn = (ctx: TxRunCtx) => ctx.out.usdg as bigint;
    steps.push(...approvalSteps('USDG', tok('USDG'), usdgIn, null));
    steps.push(
      swapStep(
        `Buy ${p.to} with that USDG`,
        'Swap 2',
        async (ctx) => {
          const amountIn = usdgIn(ctx);
          // Re-quoted for the exact USDG the first leg paid out; the minimum stays the one the review showed.
          const q = await bestQuote(poolsOf(p.to), 'buy', amountIn);
          return { hop: q?.hop ?? p.second!, amountIn, minOut: p.minOut };
        },
        'received',
      ),
    );
  }
  const route = two ? `${poolLabel(p.first.pool)}, then ${poolLabel(p.second!.pool)}` : poolLabel(p.first.pool);
  const review: Row[] = [
    ['You pay', amt(p.amountIn, p.from)],
    ['You get (est.)', amt(p.quoteOut, p.to)],
    ['Minimum you get', amt(p.minOut, p.to)],
    ['Route', route],
    ['Approvals', 'Exact amounts only, skipped when already given'],
    ['Visible onchain', 'Your wallet, the tokens and the amounts (a public Uniswap trade)'],
  ];
  return {
    title: p.title,
    review,
    note: `A real trade from your wallet through Uniswap on Robinhood Chain. Velum adds no fee: the pool fee is already in the quote. If the price moves past your slippage limit, the swap is refused onchain and nothing is traded.${two ? ' Two Stock Tokens trade through USDG in two swaps; if the second would give less than your minimum, it is refused and you keep the USDG.' : ''}`,
    confirmLabel: 'Start trade',
    ack: 'I understand this is a real trade with real tokens on Robinhood Chain mainnet, routed through Uniswap, and cannot be undone.',
    steps,
    done: (ctx) => {
      const got = (ctx.out.received as bigint | undefined) ?? 0n;
      const rows: Row[] = [
        ['Paid', amt(p.amountIn, p.from)],
        ['Received', amt(got, p.to)],
      ];
      if (two && typeof ctx.out.usdg === 'bigint') rows.push(['Through', amt(ctx.out.usdg, 'USDG')]);
      return { rows, toast: p.toast };
    },
    d,
    proto,
    account: p.account,
  };
}

export interface UniEthBuyInput {
  account: Address;
  sym: string;
  /** ETH in wei. */
  amountIn: bigint;
  quoteOut: bigint;
  minOut: bigint;
  /** The market's v3 pool of the second hop. */
  pool: UniPool;
}

/**
 * Buying a Stock Token with ETH from the wallet: one transaction through the Universal Router (wrap the ETH, then
 * WETH -> USDG -> stock over the ETH leg and the market's v3 pool), refused onchain below the minimum. No approval: ETH
 * is sent with the call. The receipt must show at least the minimum of the stock arriving in the wallet.
 */
export function uniEthBuyFlow(p: UniEthBuyInput): TxFlowSpec {
  const cfg = UNISWAP!;
  const { d, proto } = uniTarget();
  const eth = (u: bigint) => exact(u, 18, 'ETH');
  const amt = (u: bigint) => exact(u, proto.decimals[p.sym]!, p.sym);
  const router = cfg.contracts.universalRouter;
  const route = `ETH to USDG (Uniswap v3, ${(cfg.ethLeg.fee / 10_000).toFixed(2)}%), then ${poolLabel(p.pool)}`;
  const step: TxStepSpec = {
    t: `Buy ${p.sym} with ${eth(p.amountIn)}`,
    d: 'One swap through the Uniswap Universal Router; refused onchain below your minimum',
    label: 'Swap',
    outToken: p.sym,
    call: async (ctx) => {
      const { commands, inputs, value } = encodeEthBuy({ weth: cfg.contracts.weth, ethFee: cfg.ethLeg.fee, pool: p.pool, amountIn: p.amountIn, minOut: p.minOut, recipient: ctx.account });
      const deadline = (await chainNow()) + SWAP_DEADLINE_S;
      return { address: router, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [commands, inputs, deadline], value };
    },
    after: (r, ctx) => {
      const got = transfers(r, lower(p.pool.stock), (_from, to) => to === lower(ctx.account));
      if (got <= 0n || got < p.minOut) throw new ReceiptMismatch('at least the minimum arriving in your wallet');
      ctx.out.received = got;
    },
  };
  return {
    title: `Buy ${p.sym} with ETH`,
    review: [
      ['You pay', eth(p.amountIn)],
      ['You get (est.)', amt(p.quoteOut)],
      ['Minimum you get', amt(p.minOut)],
      ['Route', route],
      ['Approvals', 'None: the ETH is sent with the swap'],
      ['Visible onchain', 'Your wallet, the tokens and the amounts (a public Uniswap trade)'],
    ],
    note: `A real trade from your wallet through Uniswap on Robinhood Chain: your ETH becomes USDG, then ${p.sym}, in one transaction. Velum adds no fee: both pool fees are already in the quote. If the price moves past your slippage limit, the swap is refused onchain and nothing is traded. Keep a little ETH for the network fee.`,
    confirmLabel: 'Start trade',
    ack: 'I understand this is a real trade with real tokens on Robinhood Chain mainnet, routed through Uniswap, and cannot be undone.',
    steps: [step],
    done: (ctx) => ({
      rows: [
        ['Paid', eth(p.amountIn)],
        ['Received', amt((ctx.out.received as bigint | undefined) ?? 0n)],
      ],
      toast: `Bought ${p.sym}`,
    }),
    d,
    proto,
    account: p.account,
  };
}
