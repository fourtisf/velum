'use client';
/**
 * Deposits into the user's own Hyperliquid account straight from the wallet: ETH or USDG on Robinhood Chain, or ETH on
 * Ethereum, bridged by Relay (relay.link) into USDC on Hyperliquid at the same address (packages/config/src/hyperliquid.ts
 * RELAY_*). A deposit from Ethereum switches the wallet to Ethereum for the one transaction and back afterwards.
 *
 * Relay's API returns the transactions to sign. Velum never sends them blindly: every quote must name this user as sender
 * and recipient, the chosen origin chain and Hyperliquid's perps USDC as the output, and its transactions may only be an
 * exact USDG approval to Relay's pinned depository and one deposit to that same depository carrying exactly the amount
 * (ETH) or nothing (USDG). Anything else is refused before the wallet is asked. The approval Velum sends itself (exact
 * amount, skipped when the allowance already covers it); the deposit is re-quoted when it runs and refused if the minimum
 * Hyperliquid would receive fell below the one the user reviewed. A retry after the deposit was sent only waits for it.
 */
import { TOKENS } from '@velum/config';
import { HL_MIN_DEPOSIT_USDC, RELAY_API, RELAY_DEPOSITORY, RELAY_ETHEREUM_CHAIN_ID, RELAY_HL_CHAIN_ID, RELAY_HL_USDC, RELAY_HL_USDC_DECIMALS, RELAY_ORIGIN_CHAIN_ID } from '@velum/config/src/hyperliquid';
import { useQuery } from '@tanstack/react-query';
import { createWalletClient, custom, decodeFunctionData, erc20Abi, isHex, type Address, type Chain, type EIP1193Provider, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { getConnection } from 'wagmi/actions';
import { publicClient, robinhoodChain } from '../chain';
import { wagmiConfig } from '../wagmi';
import { l1 } from '../ethereumEth';
import { hlUsdcTotal } from './deposit';
import type { HlFlowSpec, HlStep } from './flows';

export type RelaySource = 'ETH' | 'USDG';
/** Where the deposit leaves from: Robinhood Chain (ETH or USDG) or Ethereum mainnet (ETH). */
export type RelayOrigin = 'robinhood' | 'ethereum';
export const ORIGINS: Record<RelayOrigin, { chainId: number; label: string; sources: readonly RelaySource[]; chain: Chain }> = {
  robinhood: { chainId: RELAY_ORIGIN_CHAIN_ID, label: 'Robinhood Chain', sources: ['ETH', 'USDG'], chain: robinhoodChain },
  ethereum: { chainId: RELAY_ETHEREUM_CHAIN_ID, label: 'Ethereum', sources: ['ETH'], chain: mainnet },
};
const ETH_ADDR = '0x0000000000000000000000000000000000000000';
const USDG = TOKENS.USDG!;
export const SOURCE_DECIMALS: Record<RelaySource, number> = { ETH: 18, USDG: USDG.decimals };
const HL_UNIT = 10n ** BigInt(RELAY_HL_USDC_DECIMALS);
/** Hyperliquid must receive at least this (8-decimal units): its 5 USDC deposit minimum. */
export const RELAY_MIN_OUT = BigInt(HL_MIN_DEPOSIT_USDC) * HL_UNIT;
/** ETH kept in the wallet for gas when depositing ETH: 0.0005 ETH on Robinhood Chain (as on the Spot ticket), 0.001 ETH on Ethereum. */
export const RELAY_ETH_RESERVE = 5n * 10n ** 14n;
export const RELAY_ETH_RESERVE_L1 = 10n ** 15n;
export const ethReserve = (origin: RelayOrigin): bigint => (origin === 'ethereum' ? RELAY_ETH_RESERVE_L1 : RELAY_ETH_RESERVE);

export interface RelayTx {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface RelayPlan {
  requestId: Hex;
  /** Relay's status path for this request (validated: /intents/status...). */
  check: string;
  deposit: RelayTx;
  /** USDC Hyperliquid will credit (8-decimal units): Relay's estimate and its guaranteed minimum. */
  out: bigint;
  minOut: bigint;
  feeUsd: number | null;
  inUsd: number | null;
  outUsd: number | null;
  seconds: number | null;
}

export class RelayQuoteError extends Error {}

const low = (a: unknown) => String(a ?? '').toLowerCase();
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Checks a Relay quote against what Velum asked for (see the file comment) and extracts the plan. Pure: unit-tested. */
export function validateQuote(q: unknown, p: { user: Address; source: RelaySource; amount: bigint; origin?: RelayOrigin }): RelayPlan {
  const origin = ORIGINS[p.origin ?? 'robinhood'];
  const bad = (why: string): never => {
    throw new RelayQuoteError(`Relay returned an unexpected route (${why}), so nothing was sent.`);
  };
  const r = q as {
    requestId?: unknown;
    steps?: Array<{ id?: unknown; requestId?: unknown; items?: Array<{ data?: Record<string, unknown>; check?: { endpoint?: unknown } }> }>;
    fees?: Record<string, { amountUsd?: unknown }>;
    details?: {
      sender?: unknown;
      recipient?: unknown;
      timeEstimate?: unknown;
      currencyIn?: { amount?: unknown; amountUsd?: unknown; currency?: { address?: unknown; chainId?: unknown } };
      currencyOut?: { amount?: unknown; minimumAmount?: unknown; amountUsd?: unknown; currency?: { address?: unknown; chainId?: unknown } };
    };
  };
  const d = r?.details;
  if (!d || !Array.isArray(r.steps)) bad('no route');
  if (low(d!.sender) !== low(p.user)) bad('another sender');
  if (low(d!.recipient) !== low(p.user)) bad('another recipient');
  const inCur = d!.currencyIn?.currency;
  const want = p.source === 'ETH' ? ETH_ADDR : low(USDG.address);
  if (!origin.sources.includes(p.source)) bad(`${p.source} from ${origin.label}`);
  if (low(inCur?.address) !== want || Number(inCur?.chainId) !== origin.chainId) bad('another input');
  if (String(d!.currencyIn?.amount) !== p.amount.toString()) bad('another amount');
  const outCur = d!.currencyOut?.currency;
  if (low(outCur?.address) !== RELAY_HL_USDC || Number(outCur?.chainId) !== RELAY_HL_CHAIN_ID) bad('another output');
  let out: bigint;
  let minOut: bigint;
  try {
    out = BigInt(String(d!.currencyOut?.amount));
    minOut = BigInt(String(d!.currencyOut?.minimumAmount ?? d!.currencyOut?.amount));
  } catch {
    return bad('no output amount');
  }
  if (out <= 0n || minOut <= 0n || minOut > out) bad('output amounts');

  let deposit: RelayTx | null = null;
  let check = '';
  let requestId: Hex | null = null;
  for (const st of r.steps!) {
    const items = st.items ?? [];
    if (st.id === 'approve') {
      if (p.source !== 'USDG' || items.length !== 1) bad('an approval it should not need');
      const t = items[0]!.data ?? {};
      if (Number(t.chainId) !== origin.chainId || low(t.to) !== low(USDG.address) || BigInt(String(t.value ?? '0')) !== 0n || !isHex(t.data)) bad('the approval');
      const call = decodeFunctionData({ abi: erc20Abi, data: t.data as Hex });
      if (call.functionName !== 'approve' || low(call.args[0]) !== RELAY_DEPOSITORY || call.args[1] !== p.amount) bad('not an exact approval to the depository');
    } else if (st.id === 'deposit') {
      if (deposit || items.length !== 1) bad('more than one deposit');
      const t = items[0]!.data ?? {};
      const value = BigInt(String(t.value ?? '0'));
      if (Number(t.chainId) !== origin.chainId) bad('another chain');
      if (low(t.to) !== RELAY_DEPOSITORY) bad('another contract');
      if (value !== (p.source === 'ETH' ? p.amount : 0n)) bad('another value');
      if (!isHex(t.data) || (t.data as string).length < 10) bad('no call data');
      deposit = { to: RELAY_DEPOSITORY, data: t.data as Hex, value };
      const ep = String(items[0]!.check?.endpoint ?? '');
      if (!/^\/intents\/status(\/v\d+)?\?requestId=0x[0-9a-fA-F]{64}$/.test(ep)) bad('no status link');
      check = ep;
      const rid = String(st.requestId ?? r.requestId ?? '');
      if (!/^0x[0-9a-fA-F]{64}$/.test(rid) || !ep.endsWith(rid)) bad('request id');
      requestId = rid as Hex;
    } else {
      bad(`an unknown step "${String(st.id)}"`);
    }
  }
  if (!deposit || !requestId) return bad('no deposit');
  const fees = r.fees ?? {};
  const feeUsd = ['gas', 'relayer', 'app'].reduce<number | null>((sum, k) => {
    const v = num(fees[k]?.amountUsd);
    return v === null ? sum : (sum ?? 0) + v;
  }, null);
  return { requestId, check, deposit, out, minOut, feeUsd, inUsd: num(d!.currencyIn?.amountUsd), outUsd: num(d!.currencyOut?.amountUsd), seconds: num(d!.timeEstimate) };
}

/** A fresh, validated quote: `amount` (base units of the source) from the user's wallet to their Hyperliquid account. */
export async function relayQuote(p: { user: Address; source: RelaySource; amount: bigint; origin?: RelayOrigin }, fetchImpl: typeof fetch = fetch): Promise<RelayPlan> {
  const body = {
    user: p.user,
    recipient: p.user,
    originChainId: ORIGINS[p.origin ?? 'robinhood'].chainId,
    destinationChainId: RELAY_HL_CHAIN_ID,
    originCurrency: p.source === 'ETH' ? ETH_ADDR : low(USDG.address),
    destinationCurrency: RELAY_HL_USDC,
    tradeType: 'EXACT_INPUT',
    amount: p.amount.toString(),
  };
  let res: Response;
  try {
    res = await fetchImpl(`${RELAY_API}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new RelayQuoteError('Relay cannot be reached right now. Try again in a moment.');
  }
  const json = (await res.json().catch(() => null)) as { message?: unknown } | null;
  if (!res.ok) {
    const msg = String(json?.message ?? '');
    if (/too low|minimum|amount too small/i.test(msg)) throw new RelayQuoteError('This amount is too small for Relay to bridge. Try a larger amount.');
    if (/insufficient|balance/i.test(msg)) throw new RelayQuoteError('Your wallet does not hold enough for this amount plus the network fee.');
    throw new RelayQuoteError(msg ? `Relay could not quote this: ${msg.slice(0, 140)}` : 'Relay could not quote this amount right now.');
  }
  return validateQuote(json, p);
}

export function useRelayQuote(user: Address | undefined, origin: RelayOrigin, source: RelaySource, amount: bigint) {
  return useQuery({
    queryKey: ['relay-quote', user, origin, source, amount.toString()],
    enabled: !!user && amount > 0n,
    staleTime: 15_000,
    refetchInterval: 20_000,
    retry: false,
    queryFn: () => relayQuote({ user: user!, origin, source, amount }),
  });
}

/** Relay's state of a request: waiting, pending, success, failure, refund, delayed or unknown. */
export async function relayStatus(check: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${RELAY_API}${check}`);
  const j = (await res.json().catch(() => null)) as { status?: unknown } | null;
  return String(j?.status ?? 'unknown');
}

/** 8-decimal USDC as "12.34" (rounded down). */
export const hlUsdcText = (u: bigint): string => `${u / HL_UNIT}.${((u % HL_UNIT) / 10n ** BigInt(RELAY_HL_USDC_DECIMALS - 2)).toString().padStart(2, '0')}`;

/** A source amount as text: ETH with up to 6 decimals, USDG with 2 (rounded down). */
export function sourceText(source: RelaySource, u: bigint): string {
  const dec = SOURCE_DECIMALS[source];
  const shown = source === 'ETH' ? 6 : 2;
  const whole = u / 10n ** BigInt(dec);
  const frac = (u % 10n ** BigInt(dec)) / 10n ** BigInt(dec - shown);
  const f = frac.toString().padStart(shown, '0').replace(/0+$/, '');
  return `${whole}${f ? `.${f}` : source === 'USDG' ? '.00' : ''}`;
}

/** Base units of an amount typed by the user, or null when it is not a plain amount with at most the token's decimals. */
export function sourceUnits(source: RelaySource, input: string): bigint | null {
  const dec = SOURCE_DECIMALS[source];
  const m = new RegExp(`^(\\d{1,12})(?:\\.(\\d{0,${dec}}))?$`).exec(input.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 10n ** BigInt(dec) + BigInt((m[2] ?? '').padEnd(dec, '0') || '0');
}

async function walletProvider(user: Address): Promise<EIP1193Provider> {
  const c = getConnection(wagmiConfig);
  if (c.status !== 'connected' || low(c.address) !== low(user)) throw new Error('Your wallet switched to another account. Reconnect the account you trade with.');
  return (await c.connector.getProvider()) as EIP1193Provider;
}

/** Puts the wallet on `origin`'s chain; true when it had to switch. */
async function onChain(provider: EIP1193Provider, origin: RelayOrigin): Promise<boolean> {
  const { chainId, label } = ORIGINS[origin];
  if (Number(await provider.request({ method: 'eth_chainId' })) === chainId) return false;
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${chainId.toString(16)}` }] });
  if (Number(await provider.request({ method: 'eth_chainId' })) !== chainId) throw new Error(`Your wallet is not on ${label}. Switch it there and try again. Nothing was sent.`);
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

/**
 * The deposit flow for the dialog (components/hyperliquid/HlFlowModal.tsx). `plan` is the quote the user reviewed;
 * `fetchImpl`, `pollMs` and `waitMs` are for tests.
 */
export function relayDepositFlow(p: { user: Address; source: RelaySource; amount: bigint; plan: RelayPlan; origin?: RelayOrigin; fetchImpl?: typeof fetch; pollMs?: number; waitMs?: number }): HlFlowSpec {
  const f = p.fetchImpl ?? fetch;
  const originKey: RelayOrigin = p.origin ?? 'robinhood';
  const origin = ORIGINS[originKey];
  /** Receipts on the origin chain: Robinhood Chain's reads, or Ethereum's. */
  const reader = originKey === 'ethereum' ? l1 : publicClient;
  const paid = `${sourceText(p.source, p.amount)} ${p.source}`;
  const steps: HlStep[] = [];
  if (p.source === 'USDG')
    steps.push({
      t: `Allow Relay to take exactly ${paid}`,
      wallet: true,
      d: 'An approval for this amount only, skipped when already given',
      run: async (ctx) => {
        const have = await publicClient.readContract({ address: USDG.address, abi: erc20Abi, functionName: 'allowance', args: [ctx.user, RELAY_DEPOSITORY] });
        if (have >= p.amount) return null;
        const provider = await walletProvider(ctx.user);
        await onChain(provider, 'robinhood');
        const wallet = createWalletClient({ account: ctx.user, chain: robinhoodChain, transport: custom(provider) });
        const hash = await wallet.writeContract({ address: USDG.address, abi: erc20Abi, functionName: 'approve', args: [RELAY_DEPOSITORY, p.amount] });
        const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (rc.status !== 'success') throw new Error('The approval was reverted on Robinhood Chain. Nothing was sent; try again.');
        return `Approved (${short(hash)})`;
      },
    });
  steps.push(
    {
      t: `Send ${paid} to your perps account through Relay`,
      wallet: true,
      d: `One transaction on ${origin.label} from your wallet to Relay${originKey === 'ethereum' ? ' (your wallet switches to Ethereum for it)' : ''}`,
      run: async (ctx) => {
        let hash = ctx.out.relayHash as Hex | undefined;
        if (!hash) {
          // Re-quoted now (quotes expire); refused if Hyperliquid would get less than the minimum the user reviewed.
          const fresh = await relayQuote({ user: ctx.user, source: p.source, amount: p.amount, origin: originKey }, f);
          if (fresh.minOut < p.plan.minOut) throw new Error(`Relay now guarantees ${hlUsdcText(fresh.minOut)} USDC, less than the ${hlUsdcText(p.plan.minOut)} you reviewed. Nothing was sent: review it again.`);
          ctx.out.base = await hlUsdcTotal(ctx.user).catch(() => null);
          const provider = await walletProvider(ctx.user);
          if (await onChain(provider, originKey)) ctx.out.switched = true;
          const wallet = createWalletClient({ account: ctx.user, chain: origin.chain, transport: custom(provider) });
          hash = await wallet.sendTransaction({ to: fresh.deposit.to, data: fresh.deposit.data, value: fresh.deposit.value });
          ctx.out.relayHash = hash;
          ctx.out.relayCheck = fresh.check;
          ctx.out.relayOut = fresh.out;
        }
        const rc = await reader.waitForTransactionReceipt({ hash, timeout: 300_000 });
        if (rc.status !== 'success') {
          ctx.out.relayHash = undefined;
          throw new Error(`The deposit was reverted on ${origin.label}, so nothing was sent. Try again.`);
        }
        return `Confirmed on ${origin.label} (${short(hash)})`;
      },
    },
    {
      t: 'Wait for Relay to deliver it',
      d: 'Usually within a minute',
      active: 'Waiting for Relay to credit USDC to your perps account…',
      run: async (ctx) => {
        const check = String(ctx.out.relayCheck ?? p.plan.check);
        const end = Date.now() + (p.waitMs ?? 600_000);
        let delivered = false;
        while (!delivered && Date.now() < end) {
          const st = await relayStatus(check, f).catch(() => 'unknown');
          if (st === 'success') {
            delivered = true;
            break;
          }
          if (st === 'refund' || st === 'refunded') throw new Error(`Relay could not complete the deposit and refunded it to your wallet on ${origin.label}.`);
          if (st === 'failure') throw new Error('Relay reports the deposit failed. If it was not refunded, contact Relay support with the transaction link.');
          await sleep(p.pollMs ?? 3000);
        }
        if (!delivered) throw new Error(`Relay has not delivered it yet. The deposit is confirmed on ${origin.label}: try again to keep waiting.`);
        // Hyperliquid shows it a moment later.
        const base = typeof ctx.out.base === 'number' ? ctx.out.base : null;
        const want = Number(hlUsdcText(p.plan.minOut)) * 0.99;
        const until = Date.now() + Math.min(60_000, p.waitMs ?? 60_000);
        while (base !== null && Date.now() < until) {
          const now = await hlUsdcTotal(ctx.user).catch(() => null);
          if (now !== null && now - base >= want) break;
          await sleep(p.pollMs ?? 3000);
        }
        return `${hlUsdcText((ctx.out.relayOut as bigint | undefined) ?? p.plan.out)} USDC delivered`;
      },
    },
  );
  if (originKey === 'ethereum')
    steps.push({
      t: 'Switch your wallet back to Robinhood Chain',
      wallet: true,
      d: 'Where spot trading on Velum runs',
      run: async (ctx) => {
        if (!ctx.out.switched) return null;
        try {
          return (await onChain(await walletProvider(ctx.user), 'robinhood')) ? 'Switched back' : null;
        } catch {
          return 'Switch back from your wallet when you are ready';
        }
      },
    });
  const fee = p.plan.feeUsd !== null ? `About $${p.plan.feeUsd.toFixed(2)} (network and Relay fees, in the quote)` : 'Included in the quote';
  return {
    title: 'Deposit to your perps account',
    review: [
      ['You send', `${paid} from your wallet on ${origin.label}`],
      ['You receive (est.)', `${hlUsdcText(p.plan.out)} USDC in your perps account`],
      ['Minimum', `${hlUsdcText(p.plan.minOut)} USDC (guaranteed by Relay)`],
      ['To', 'Your perps account (this same address)'],
      ['Venue', 'Hyperliquid, where your perps account is held'],
      ['Route', 'Relay, a cross-chain service'],
      ['Fees', fee],
      ...(originKey === 'ethereum' ? ([['Network', 'Ethereum mainnet: your wallet switches there for the deposit and back to Robinhood Chain after']] as Array<[string, string]>) : []),
      ['Arrives', p.plan.seconds !== null && p.plan.seconds <= 60 ? 'Usually within a minute' : 'Usually within a few minutes'],
    ],
    note: `A real deposit: your wallet sends ${paid} to Relay's contract on ${origin.label}, and Relay credits USDC to your perps account at this same address. If Relay cannot complete it, it refunds you on ${origin.label}. Velum never holds the funds.`,
    ack: `I understand this sends real ${p.source} from my wallet on ${origin.label} through Relay to my perps account.`,
    confirmLabel: 'Deposit',
    footer: 'Your wallet signs the deposit itself. Velum never holds your funds.',
    failToast: 'Deposit not completed',
    steps,
    done: (ctx) => {
      const h = ctx.out.relayHash as string | undefined;
      return {
        rows: [
          ['Sent', paid],
          ['Delivered', `${hlUsdcText((ctx.out.relayOut as bigint | undefined) ?? p.plan.out)} USDC to your perps account`],
          [`${origin.label} tx`, h ? short(h) : '—'],
        ],
        toast: 'Deposit delivered',
      };
    },
    user: p.user,
  };
}
