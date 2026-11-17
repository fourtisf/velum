'use client';
/**
 * Withdrawals from the user's own Hyperliquid perps account back to their wallet, at the same address:
 *  - through Relay to Robinhood Chain (USDG or ETH) or Ethereum (ETH): two signatures in the wallet, no gas: Relay's
 *    "nonce mapping" (posted to Relay's /authorize, signed on the wallet's current chain), then a Hyperliquid sendAsset
 *    of the USDC with that same nonce to Relay's pinned Hyperliquid address; Relay's solver pays out on the destination;
 *  - straight to Arbitrum: Hyperliquid's own withdraw3 (USDC on Arbitrum, the exchange's 1 USDC fee).
 * Standard accounts first move what is needed from the stock perps (xyz) balance to the main USDC balance, signed by the
 * browser's agent (which can move money only between the user's own balances, never out).
 *
 * Relay's quote is never signed as given: it must name this user as sender and recipient, Hyperliquid's perps USDC and
 * exactly the amount as input, the chosen chain and token as output, the nonce-mapping message Velum expects (this
 * user, Relay's domain) and a sendAsset of exactly the amount, from the balance the account keeps its USDC in, to
 * RELAY_HL_DEPOSIT_ADDRESS (packages/config/src/hyperliquid.ts). Velum builds both signed messages itself from the
 * checked values. The quote is fetched again when the withdrawal runs and refused if Relay now guarantees less than the
 * user reviewed.
 */
import { TOKENS } from '@velum/config';
import {
  HL_MIN_ARB_WITHDRAW_USDC,
  HL_MIN_RELAY_WITHDRAW_USDC,
  HL_USDC_TOKEN,
  HL_WITHDRAW_FEE_USDC,
  RELAY_API,
  RELAY_ETHEREUM_CHAIN_ID,
  RELAY_HL_CHAIN_ID,
  RELAY_HL_DEPOSIT_ADDRESS,
  RELAY_HL_USDC,
  RELAY_ORIGIN_CHAIN_ID,
} from '@velum/config/src/hyperliquid';
import { useQuery } from '@tanstack/react-query';
import type { Address, Hex } from 'viem';
import { freshBalances, moveFromXyz, userExchange, userWallet, type HlBalances, type HlMode } from './client';
import { enableStep, type HlFlowSpec, type HlStep } from './flows';

/** Where the money goes: Robinhood Chain or Ethereum through Relay, or Arbitrum straight from the exchange. */
export type WithdrawTo = 'robinhood' | 'ethereum' | 'arb';
export type RelayDest = Exclude<WithdrawTo, 'arb'>;
export type WithdrawAsset = 'USDG' | 'ETH';
export const DESTS: Record<RelayDest, { chainId: number; label: string; assets: readonly WithdrawAsset[] }> = {
  robinhood: { chainId: RELAY_ORIGIN_CHAIN_ID, label: 'Robinhood Chain', assets: ['USDG', 'ETH'] },
  ethereum: { chainId: RELAY_ETHEREUM_CHAIN_ID, label: 'Ethereum', assets: ['ETH'] },
};
const ETH_ADDR = '0x0000000000000000000000000000000000000000';
const USDG = TOKENS.USDG!;
const OUT_DECIMALS: Record<WithdrawAsset, number> = { ETH: 18, USDG: USDG.decimals };
const ZERO = '0x0000000000000000000000000000000000000000';

// ---------- USDC amounts: micro-USDC (6 decimals) as bigint ----------
const MICRO = 1_000_000n;
/** Micro-USDC of a balance number from the API, rounded down. */
export const toMicro = (n: number): bigint => (Number.isFinite(n) && n > 0 ? BigInt(Math.floor(n * 1e6)) : 0n);
/** What can be withdrawn now: free USDC (margin in open positions stays), across the main and stock perps balances. */
export const withdrawableMicro = (b: HlBalances): bigint => toMicro(b.xyzAvailable) + toMicro(b.mainAvailable);
/** "12.34" (2 decimals, rounded down). */
export const microText = (u: bigint): string => `${u / MICRO}.${((u % MICRO) / 10_000n).toString().padStart(2, '0')}`;
/** The exact amount as Hyperliquid takes it: "12.5", "0.000001", "3". */
export function microExact(u: bigint): string {
  const f = (u % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  return `${u / MICRO}${f ? `.${f}` : ''}`;
}
/** Micro-USDC of an amount typed by the user (at most 6 decimals), or null. */
export function parseUsdc(input: string): bigint | null {
  const m = /^(\d{1,9})(?:\.(\d{0,6}))?$/.exec(input.trim());
  if (!m) return null;
  return BigInt(m[1]!) * MICRO + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
}
/** Micro-USDC of a decimal string from Relay ("12.000000"), or null. */
const decMicro = (v: unknown): bigint | null => (typeof v === 'string' ? parseUsdc(v) : null);
/** An output amount as text: USDG with 2 decimals, ETH with 6 (rounded down). */
export function outText(asset: WithdrawAsset, u: bigint): string {
  const dec = OUT_DECIMALS[asset];
  const shown = asset === 'ETH' ? 6 : 2;
  const whole = u / 10n ** BigInt(dec);
  const frac = (u % 10n ** BigInt(dec)) / 10n ** BigInt(dec - shown);
  const f = frac.toString().padStart(shown, '0');
  return `${whole}.${asset === 'ETH' ? f.replace(/0+$/, '') || '0' : f}`;
}
/** The balance Relay takes the USDC from: "spot" for unified and portfolio-margin accounts, the main perps balance otherwise. */
export const relaySourceDex = (mode: HlMode): '' | 'spot' => (mode === 'standard' ? '' : 'spot');

// ---------- Relay quote ----------
/** Relay's nonce-mapping message types (the quote must carry exactly these; Velum signs its own copy). */
export const NONCE_MAPPING_TYPES = {
  NonceMapping: [
    { name: 'chainId', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'depositor', type: 'address' },
    { name: 'id', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export interface WithdrawPlan {
  requestId: Hex;
  /** Relay's status path (validated: /intents/status...). */
  check: string;
  /** The nonce-mapping id and the nonce shared by both signatures. */
  id: Hex;
  nonce: number;
  /** The sendAsset to sign (all checked). */
  send: { destination: Address; sourceDex: '' | 'spot'; token: string; amount: string };
  /** Destination units of the chosen token: Relay's estimate and its guaranteed minimum. */
  out: bigint;
  minOut: bigint;
  feeUsd: number | null;
  outUsd: number | null;
  seconds: number | null;
}

export class WithdrawQuoteError extends Error {}

const low = (a: unknown) => String(a ?? '').toLowerCase();
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Checks a Relay quote out of Hyperliquid against what Velum asked for (see the file comment). Pure: unit-tested. */
export function validateWithdrawQuote(q: unknown, p: { user: Address; to: RelayDest; asset: WithdrawAsset; amount: bigint; sourceDex: '' | 'spot' }): WithdrawPlan {
  const dest = DESTS[p.to];
  const bad = (why: string): never => {
    throw new WithdrawQuoteError(`Relay returned an unexpected route (${why}), so nothing was sent.`);
  };
  const r = q as {
    steps?: Array<{ id?: unknown; kind?: unknown; requestId?: unknown; items?: Array<{ data?: Record<string, unknown>; check?: { endpoint?: unknown } }> }>;
    fees?: Record<string, { amountUsd?: unknown }>;
    details?: {
      sender?: unknown;
      recipient?: unknown;
      timeEstimate?: unknown;
      currencyIn?: { amount?: unknown; currency?: { address?: unknown; chainId?: unknown } };
      currencyOut?: { amount?: unknown; minimumAmount?: unknown; amountUsd?: unknown; currency?: { address?: unknown; chainId?: unknown } };
    };
  };
  const d = r?.details;
  if (!d || !Array.isArray(r.steps)) bad('no route');
  if (!dest.assets.includes(p.asset)) bad(`${p.asset} to ${dest.label}`);
  if (low(d!.sender) !== low(p.user)) bad('another sender');
  if (low(d!.recipient) !== low(p.user)) bad('another recipient');
  const inCur = d!.currencyIn?.currency;
  if (low(inCur?.address) !== RELAY_HL_USDC || Number(inCur?.chainId) !== RELAY_HL_CHAIN_ID) bad('another input');
  if (String(d!.currencyIn?.amount) !== (p.amount * 100n).toString()) bad('another amount');
  const outCur = d!.currencyOut?.currency;
  const want = p.asset === 'ETH' ? ETH_ADDR : low(USDG.address);
  if (low(outCur?.address) !== want || Number(outCur?.chainId) !== dest.chainId) bad('another output');
  let out: bigint;
  let minOut: bigint;
  try {
    out = BigInt(String(d!.currencyOut?.amount));
    minOut = BigInt(String(d!.currencyOut?.minimumAmount ?? d!.currencyOut?.amount));
  } catch {
    return bad('no output amount');
  }
  if (out <= 0n || minOut <= 0n || minOut > out) bad('output amounts');
  if (r.steps!.length !== 2) bad('not two steps');
  const [a, s] = r.steps!;
  // 1. The nonce mapping, signed in the wallet and posted to Relay.
  if (a!.id !== 'authorize' || a!.kind !== 'signature' || a!.items?.length !== 1) bad('no authorization step');
  const sign = (a!.items![0]!.data?.sign ?? {}) as { signatureKind?: unknown; domain?: Record<string, unknown>; types?: unknown; value?: Record<string, unknown>; primaryType?: unknown };
  const post = (a!.items![0]!.data?.post ?? {}) as { endpoint?: unknown; method?: unknown; body?: Record<string, unknown> };
  const dom = sign.domain ?? {};
  if (sign.signatureKind !== 'eip712' || dom.name !== 'RelayNonceMapping' || dom.version !== '2' || low(dom.verifyingContract) !== ZERO) bad('the authorization domain');
  if (sign.primaryType !== 'NonceMapping' || JSON.stringify(sign.types) !== JSON.stringify(NONCE_MAPPING_TYPES)) bad('the authorization message');
  const v = sign.value ?? {};
  const id = String(v.id ?? '');
  const nonce = Number(v.nonce);
  if (v.chainId !== 'hyperliquid' || low(v.wallet) !== low(p.user) || low(v.depositor) !== low(p.user) || !/^0x[0-9a-fA-F]{64}$/.test(id) || !Number.isSafeInteger(nonce) || nonce <= 0) bad('the authorization values');
  const pb = post.body ?? {};
  if (post.endpoint !== '/authorize' || post.method !== 'POST' || pb.type !== 'nonce-mapping' || Number(pb.walletChainId) !== RELAY_HL_CHAIN_ID || low(pb.wallet) !== low(p.user) || low(pb.depositor) !== low(p.user) || Number(pb.nonce) !== nonce || pb.id !== id) bad('the authorization request');
  // 2. The transfer: exactly the amount, to Relay's Hyperliquid address, with the same nonce.
  if (s!.id !== 'deposit' || s!.items?.length !== 1) bad('no transfer step');
  const t = s!.items![0]!.data ?? {};
  const action = (t.action ?? {}) as { type?: unknown; parameters?: Record<string, unknown> };
  const pr = action.parameters ?? {};
  if (action.type !== 'sendAsset' || t.eip712PrimaryType !== 'HyperliquidTransaction:SendAsset') bad('not a transfer');
  if (pr.hyperliquidChain !== 'Mainnet') bad('another network');
  if (low(pr.destination) !== RELAY_HL_DEPOSIT_ADDRESS) bad('another destination');
  if (pr.sourceDex !== p.sourceDex || pr.destinationDex !== '' || pr.token !== HL_USDC_TOKEN || (pr.fromSubAccount ?? '') !== '') bad('another balance or token');
  if (decMicro(pr.amount) !== p.amount) bad('another transfer amount');
  if (Number(pr.nonce) !== nonce || Number(t.nonce) !== nonce) bad('another nonce');
  const ep = String(s!.items![0]!.check?.endpoint ?? '');
  const rid = String(s!.requestId ?? '');
  if (!/^\/intents\/status(\/v\d+)?\?requestId=0x[0-9a-fA-F]{64}$/.test(ep) || !/^0x[0-9a-fA-F]{64}$/.test(rid) || !ep.endsWith(rid) || String(a!.requestId ?? rid) !== rid) bad('request id');
  const fees = r.fees ?? {};
  const feeUsd = ['gas', 'relayer', 'app'].reduce<number | null>((sum, k) => {
    const x = num(fees[k]?.amountUsd);
    return x === null ? sum : (sum ?? 0) + x;
  }, null);
  return {
    requestId: rid as Hex,
    check: ep,
    id: id as Hex,
    nonce,
    send: { destination: RELAY_HL_DEPOSIT_ADDRESS, sourceDex: p.sourceDex, token: HL_USDC_TOKEN, amount: String(pr.amount) },
    out,
    minOut,
    feeUsd,
    outUsd: num(d!.currencyOut?.amountUsd),
    seconds: num(d!.timeEstimate),
  };
}

/** A fresh, validated quote: `amount` micro-USDC from the user's perps account to their wallet on `to`. */
export async function relayWithdrawQuote(p: { user: Address; to: RelayDest; asset: WithdrawAsset; amount: bigint; sourceDex: '' | 'spot' }, fetchImpl: typeof fetch = fetch): Promise<WithdrawPlan> {
  const body = {
    user: p.user,
    recipient: p.user,
    originChainId: RELAY_HL_CHAIN_ID,
    destinationChainId: DESTS[p.to].chainId,
    originCurrency: RELAY_HL_USDC,
    destinationCurrency: p.asset === 'ETH' ? ETH_ADDR : low(USDG.address),
    tradeType: 'EXACT_INPUT',
    amount: (p.amount * 100n).toString(),
  };
  let res: Response;
  try {
    res = await fetchImpl(`${RELAY_API}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new WithdrawQuoteError('Relay cannot be reached right now. Try again in a moment.');
  }
  const json = (await res.json().catch(() => null)) as { message?: unknown } | null;
  if (!res.ok) {
    const msg = String(json?.message ?? '');
    if (/too low|minimum|amount too small/i.test(msg)) throw new WithdrawQuoteError('This amount is too small for Relay to bridge. Try a larger amount.');
    throw new WithdrawQuoteError(msg ? `Relay could not quote this: ${msg.slice(0, 140)}` : 'Relay could not quote this amount right now.');
  }
  return validateWithdrawQuote(json, p);
}

export function useRelayWithdrawQuote(user: Address | undefined, to: RelayDest, asset: WithdrawAsset, amount: bigint, sourceDex: '' | 'spot' | null) {
  return useQuery({
    queryKey: ['relay-withdraw-quote', user, to, asset, amount.toString(), sourceDex],
    enabled: !!user && amount > 0n && sourceDex !== null,
    staleTime: 15_000,
    refetchInterval: 20_000,
    retry: false,
    queryFn: () => relayWithdrawQuote({ user: user!, to, asset, amount, sourceDex: sourceDex! }),
  });
}

/** Signs Relay's nonce mapping in the user's wallet (on its current chain) and posts it to Relay's /authorize. */
export async function authorizeWithdraw(user: Address, plan: WithdrawPlan, fetchImpl: typeof fetch = fetch): Promise<void> {
  const wallet = await userWallet(user);
  const chainId = await wallet.getChainId();
  const signature = await wallet.signTypedData({
    account: user,
    domain: { name: 'RelayNonceMapping', version: '2', chainId, verifyingContract: ZERO },
    types: NONCE_MAPPING_TYPES,
    primaryType: 'NonceMapping',
    message: { chainId: 'hyperliquid', wallet: user, depositor: user, id: plan.id, nonce: BigInt(plan.nonce) },
  });
  const body = { type: 'nonce-mapping', walletChainId: RELAY_HL_CHAIN_ID, wallet: user, nonce: plan.nonce, id: plan.id, depositor: user, signatureChainId: chainId };
  let res: Response;
  try {
    res = await fetchImpl(`${RELAY_API}/authorize?signature=${signature}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('Relay cannot be reached right now. Nothing was sent; try again.');
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
    throw new Error(`Relay refused the authorization (${String(j?.error ?? j?.message ?? res.status).slice(0, 80)}). Nothing was sent; try again.`);
  }
}

/** Relay's state of a request (waiting, pending, success, failure, refund, delayed) and its transaction hashes, if any. */
export async function withdrawStatus(check: string, fetchImpl: typeof fetch = fetch): Promise<{ status: string; txHashes: string[] }> {
  const res = await fetchImpl(`${RELAY_API}${check}`);
  const j = (await res.json().catch(() => null)) as { status?: unknown; txHashes?: unknown } | null;
  const txHashes = Array.isArray(j?.txHashes) ? (j!.txHashes as unknown[]).filter((h): h is string => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h)) : [];
  return { status: String(j?.status ?? 'unknown'), txHashes };
}

// ---------- Flows ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const VENUE: [string, string] = ['Venue', 'Hyperliquid, where your perps account is held'];
const FOOTER = 'Your wallet signs the withdrawal itself (no gas). The trading key in this browser can never withdraw.';

/**
 * Step: makes sure `amount` is free to withdraw, and on standard accounts moves what the main USDC balance lacks out of
 * the stock perps balance (signed by this browser's agent, approved first if needed).
 */
export function moveOutStep(amount: bigint): HlStep {
  return {
    t: 'Free the USDC in your perps account',
    wallet: true,
    d: 'Moves it from the stock perps balance to the main USDC balance when needed; skipped otherwise',
    active: 'Checking your perps balances…',
    run: async (ctx) => {
      const { mode, bal } = await freshBalances(ctx.user);
      const free = withdrawableMicro(bal);
      if (free < amount) throw new Error(`Your perps account has ${microText(free)} USDC free to withdraw, less than ${microText(amount)}. Nothing was sent.`);
      if (mode !== 'standard') return null;
      const main = toMicro(bal.mainAvailable);
      if (main >= amount) return null;
      await enableStep().run(ctx);
      if (!ctx.agent) throw new Error('This browser is not approved to move USDC within your account yet. Nothing was sent.');
      const move = amount - main;
      await moveFromXyz(ctx.agent, microExact(move));
      return `Moved ${microText(move)} USDC to the main balance`;
    },
  };
}

/** The withdrawal through Relay, for the dialog (components/hyperliquid/HlFlowModal.tsx). `plan` is the reviewed quote. */
export function relayWithdrawFlow(p: { user: Address; to: RelayDest; asset: WithdrawAsset; amount: bigint; plan: WithdrawPlan; fetchImpl?: typeof fetch; pollMs?: number; waitMs?: number }): HlFlowSpec {
  const f = p.fetchImpl ?? fetch;
  const dest = DESTS[p.to];
  const usdc = `${microText(p.amount)} USDC`;
  const quoteNow = async (user: Address): Promise<WithdrawPlan> => {
    const { mode } = await freshBalances(user);
    const fresh = await relayWithdrawQuote({ user, to: p.to, asset: p.asset, amount: p.amount, sourceDex: relaySourceDex(mode) }, f);
    if (fresh.minOut < p.plan.minOut)
      throw new Error(`Relay now guarantees ${outText(p.asset, fresh.minOut)} ${p.asset}, less than the ${outText(p.asset, p.plan.minOut)} you reviewed. Nothing was sent: review it again.`);
    return fresh;
  };
  const steps: HlStep[] = [
    moveOutStep(p.amount),
    {
      t: 'Authorize the withdrawal with Relay',
      wallet: true,
      d: 'Your wallet signs a message (no gas) that ties this transfer to your Relay order',
      run: async (ctx) => {
        if (ctx.out.sent) return null;
        const fresh = await quoteNow(ctx.user);
        await authorizeWithdraw(ctx.user, fresh, f);
        ctx.out.plan = fresh;
        ctx.out.authorizedAt = Date.now();
        return 'Signed in your wallet';
      },
    },
    {
      t: `Send ${usdc} to Relay`,
      wallet: true,
      d: 'Your wallet signs the transfer out of your perps account (no gas)',
      run: async (ctx) => {
        if (ctx.out.sent) return 'Already sent';
        let plan = ctx.out.plan as WithdrawPlan | undefined;
        // A retry long after the authorization asks for a fresh quote and authorization first.
        if (!plan || Date.now() - Number(ctx.out.authorizedAt ?? 0) > 120_000) {
          plan = await quoteNow(ctx.user);
          await authorizeWithdraw(ctx.user, plan, f);
          ctx.out.plan = plan;
          ctx.out.authorizedAt = Date.now();
        }
        const ex = await userExchange(ctx.user, plan.nonce);
        await ex.sendAsset({ destination: plan.send.destination, sourceDex: plan.send.sourceDex, destinationDex: '', token: plan.send.token, amount: plan.send.amount, fromSubAccount: '' });
        ctx.out.sent = true;
        return `Sent ${usdc}`;
      },
    },
    {
      t: 'Wait for Relay to deliver it',
      d: 'Usually within a minute',
      active: `Waiting for Relay to send ${p.asset} to your wallet on ${dest.label}…`,
      run: async (ctx) => {
        const plan = (ctx.out.plan as WithdrawPlan | undefined) ?? p.plan;
        const end = Date.now() + (p.waitMs ?? 600_000);
        while (Date.now() < end) {
          const st = await withdrawStatus(plan.check, f).catch(() => ({ status: 'unknown', txHashes: [] as string[] }));
          if (st.status === 'success') {
            ctx.out.txHash = st.txHashes[st.txHashes.length - 1];
            return `${outText(p.asset, plan.out)} ${p.asset} delivered on ${dest.label}`;
          }
          if (st.status === 'refund' || st.status === 'refunded') throw new Error('Relay could not complete the withdrawal and refunded the USDC to you.');
          if (st.status === 'failure') throw new Error('Relay reports the withdrawal failed. If it was not refunded, contact Relay support with the request id.');
          await sleep(p.pollMs ?? 3000);
        }
        throw new Error(`Relay has not delivered it yet. The USDC was sent to Relay: try again to keep waiting.`);
      },
    },
  ];
  const fee = p.plan.feeUsd !== null ? `About $${p.plan.feeUsd.toFixed(2)} (Relay's fees, in the quote)` : 'Included in the quote';
  return {
    title: 'Withdraw from your perps account',
    review: [
      ['You withdraw', `${usdc} from your perps account`],
      ['You receive (est.)', `${outText(p.asset, p.plan.out)} ${p.asset} on ${dest.label}`],
      ['Minimum', `${outText(p.asset, p.plan.minOut)} ${p.asset} (guaranteed by Relay)`],
      ['To', `Your wallet on ${dest.label} (this same address)`],
      VENUE,
      ['Route', 'Relay, a cross-chain service'],
      ['Fees', fee],
      ['Signatures', 'Two in your wallet, no gas'],
      ['Arrives', p.plan.seconds !== null && p.plan.seconds <= 60 ? 'Usually within a minute' : 'Usually within a few minutes'],
    ],
    note: `A real withdrawal: your wallet signs a transfer of ${usdc} from your perps account to Relay, and Relay sends ${p.asset} to this same address on ${dest.label}. If Relay cannot complete it, it refunds you. Velum never holds the funds.`,
    ack: `I understand this withdraws real USDC from my perps account through Relay to my wallet on ${dest.label}.`,
    confirmLabel: 'Withdraw',
    footer: FOOTER,
    failToast: 'Withdrawal not completed',
    steps,
    done: (ctx) => {
      const plan = (ctx.out.plan as WithdrawPlan | undefined) ?? p.plan;
      const h = ctx.out.txHash as string | undefined;
      return {
        rows: [
          ['Withdrew', usdc],
          ['Delivered', `${outText(p.asset, plan.out)} ${p.asset} to your wallet on ${dest.label}`],
          h ? [`${dest.label} tx`, short(h)] : ['Relay request', short(plan.requestId)],
        ],
        toast: 'Withdrawal delivered',
      };
    },
    user: p.user,
  };
}

/** Hyperliquid's own withdrawal of `amount` micro-USDC to the same address on Arbitrum (the exchange keeps its fee). */
export function arbWithdrawFlow(p: { user: Address; amount: bigint }): HlFlowSpec {
  const usdc = `${microText(p.amount)} USDC`;
  const fee = BigInt(HL_WITHDRAW_FEE_USDC) * MICRO;
  const gets = `${microText(p.amount > fee ? p.amount - fee : 0n)} USDC`;
  return {
    title: 'Withdraw from your perps account',
    review: [
      ['You withdraw', `${usdc} from your perps account`],
      ['You receive', `${gets} on Arbitrum`],
      ['Fee', `${HL_WITHDRAW_FEE_USDC} USDC, charged by the exchange`],
      ['To', 'Your wallet on Arbitrum (this same address)'],
      VENUE,
      ['Arrives', 'Usually within about 5 minutes'],
    ],
    note: `A real withdrawal: your wallet signs it (no gas) and the exchange sends ${gets} to this same address on Arbitrum. Velum never holds the funds.`,
    ack: 'I understand this withdraws real USDC from my perps account to my wallet on Arbitrum.',
    confirmLabel: 'Withdraw',
    footer: FOOTER,
    failToast: 'Withdrawal not completed',
    steps: [
      moveOutStep(p.amount),
      {
        t: `Withdraw ${usdc} to Arbitrum`,
        wallet: true,
        d: 'Your wallet signs the withdrawal (no gas)',
        run: async (ctx) => {
          if (ctx.out.sent) return 'Already sent';
          const ex = await userExchange(ctx.user);
          await ex.withdraw3({ destination: ctx.user, amount: microExact(p.amount) });
          ctx.out.sent = true;
          return 'Accepted: on its way to Arbitrum';
        },
      },
    ],
    done: () => ({
      rows: [
        ['Withdrew', usdc],
        ['Arrives', `${gets} on Arbitrum, usually within about 5 minutes`],
      ],
      toast: 'Withdrawal on its way',
    }),
    user: p.user,
  };
}

/** Why a withdrawal amount cannot go ahead yet (for the dialog's button), or null. Pure. */
export function withdrawRefusal(amount: bigint | null, free: bigint | null, to: WithdrawTo): 'amount' | 'loading' | 'balance' | 'min' | null {
  if (amount === null || amount === 0n) return 'amount';
  if (free === null) return 'loading';
  if (amount > free) return 'balance';
  if (amount < BigInt(to === 'arb' ? HL_MIN_ARB_WITHDRAW_USDC : HL_MIN_RELAY_WITHDRAW_USDC) * MICRO) return 'min';
  return null;
}
