'use client';
/**
 * Hyperliquid reads and actions for real perps (Robinhood Chain mainnet builds; packages/config/src/hyperliquid.ts).
 * The browser talks to api.hyperliquid.xyz directly (the deploy's CSP allows it), so each user's requests count against
 * their own IP's rate limit (1200 weight per minute): balances and positions every 6 s (weight 2 each), the
 * account mode once a minute and after each action, the mid prices every 5 s, fills once a minute while shown, the
 * market list once an hour.
 *
 * Signing: the user's wallet signs approvals (approveAgent, and approveBuilderFee when the build sets a fee) and
 * withdrawals (withdraw3, or a sendAsset to Relay: lib/hyperliquid/withdraw.ts), all EIP-712 with no gas; Hyperliquid
 * accepts the wallet's current chain as signatureChainId, checked against the live API with Robinhood Chain's 0x1237.
 * Orders, leverage and transfers between the user's own Hyperliquid balances are signed by the browser-held agent
 * (lib/hyperliquid/agent.ts), which can never withdraw.
 */
import { HL_DEX, HL_MARKETS, HL_USDC_TOKEN, hlCheckMarket, type HlMarket } from '@velum/config/src/hyperliquid';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { useQuery } from '@tanstack/react-query';
import { privateKeyToAccount } from 'viem/accounts';
import { getConnection, getWalletClient } from 'wagmi/actions';
import { wagmiConfig } from '../wagmi';
import { newAgent, saveAgent, type StoredAgent } from './agent';
import type { Builder } from './order';

export const transport = new HttpTransport({ timeout: 15_000 });
export const info = new InfoClient({ transport });

/** Velum's builder fee, from the build (NEXT_PUBLIC_HL_BUILDER_ADDRESS and NEXT_PUBLIC_HL_BUILDER_FEE in tenths of a bp). 0% when unset. */
export function builderFromEnv(addr = process.env.NEXT_PUBLIC_HL_BUILDER_ADDRESS, fee = process.env.NEXT_PUBLIC_HL_BUILDER_FEE): Builder | null {
  const f = Number(fee);
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr) || !Number.isInteger(f) || f <= 0 || f > 100) return null;
  return { b: addr.toLowerCase() as `0x${string}`, f };
}
export const BUILDER = builderFromEnv();

export interface HlPosition {
  coin: string;
  symbol: string;
  /** Signed size in coins (negative: short). */
  szi: string;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  liquidationPx: string | null;
  marginUsed: string;
  leverage: number;
  isolated: boolean;
}

export type HlMode = 'unified' | 'portfolio' | 'standard';

export interface HlBalances {
  /** Usable for new xyz positions now: the unified USDC balance (unified / portfolio margin) or the xyz dex's own. */
  xyzAvailable: number;
  /** Standard accounts only: what the main perp balance can move to xyz (0 otherwise). */
  mainAvailable: number;
  positions: HlPosition[];
  /** Any USDC or position anywhere: Hyperliquid refuses approveAgent before a first deposit. */
  funded: boolean;
}

const num = (v: unknown): number => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : 0);
const symbolOf = (coin: string): string | null => Object.values(HL_MARKETS).find((m) => m.coin === coin)?.symbol ?? null;

/** The Velum markets' xyz positions from a clearinghouseState answer (others, if any, are left out). */
export function readPositions(state: unknown): HlPosition[] {
  const list = (state as { assetPositions?: unknown[] } | null)?.assetPositions;
  if (!Array.isArray(list)) return [];
  const out: HlPosition[] = [];
  for (const ap of list) {
    const p = (ap as { position?: Record<string, unknown> } | null)?.position;
    if (!p || typeof p.coin !== 'string' || typeof p.szi !== 'string' || num(p.szi) === 0) continue;
    const symbol = symbolOf(p.coin);
    if (!symbol) continue;
    const lev = p.leverage as { type?: unknown; value?: unknown } | undefined;
    out.push({
      coin: p.coin,
      symbol,
      szi: p.szi,
      entryPx: String(p.entryPx ?? ''),
      positionValue: String(p.positionValue ?? '0'),
      unrealizedPnl: String(p.unrealizedPnl ?? '0'),
      returnOnEquity: String(p.returnOnEquity ?? '0'),
      liquidationPx: typeof p.liquidationPx === 'string' ? p.liquidationPx : null,
      marginUsed: String(p.marginUsed ?? '0'),
      leverage: typeof lev?.value === 'number' ? lev.value : 0,
      isolated: lev?.type === 'isolated',
    });
  }
  return out;
}

/** The account mode from userAbstraction: unified and portfolio margin share one USDC balance; everything else is standard. */
export function modeOf(abstraction: unknown): HlMode {
  return abstraction === 'unifiedAccount' ? 'unified' : abstraction === 'portfolioMargin' ? 'portfolio' : 'standard';
}

/** Balances from the three state reads (pure, for tests). */
export function readBalances(mode: HlMode, xyz: unknown, main: unknown, spot: unknown): HlBalances {
  const usdc = ((spot as { balances?: Array<{ coin?: string; total?: string; hold?: string }> } | null)?.balances ?? []).find((b) => b.coin === 'USDC');
  const spotFree = Math.max(0, num(usdc?.total) - num(usdc?.hold));
  const xyzW = num((xyz as { withdrawable?: unknown } | null)?.withdrawable);
  const mainW = num((main as { withdrawable?: unknown } | null)?.withdrawable);
  const positions = readPositions(xyz);
  const shared = mode !== 'standard';
  return {
    xyzAvailable: shared ? spotFree : xyzW,
    mainAvailable: shared ? 0 : mainW,
    positions,
    funded: spotFree > 0 || xyzW > 0 || mainW > 0 || num(usdc?.total) > 0 || num((main as { marginSummary?: { accountValue?: unknown } } | null)?.marginSummary?.accountValue) > 0 || positions.length > 0,
  };
}

/** The xyz market list (meta), checked against the pinned indices: symbol -> market, or none for a moved market. */
export function useHlMarkets() {
  return useQuery({
    queryKey: ['hl-meta'],
    staleTime: 3_600_000,
    retry: 2,
    queryFn: async () => {
      const meta = await info.meta({ dex: HL_DEX });
      const out: Record<string, HlMarket> = {};
      for (const s of Object.keys(HL_MARKETS)) {
        const m = hlCheckMarket(s, meta.universe);
        if (m) out[s] = m;
      }
      return out;
    },
  });
}

/** The account mode (userAbstraction): once a minute and after each action, shared by the ticket and the positions. */
export function useHlMode(user: `0x${string}` | undefined) {
  return useQuery({
    queryKey: ['hl-mode', user],
    enabled: !!user,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => modeOf(await info.userAbstraction({ user: user! })),
  });
}

/** Balances and positions every 6 s. */
export function useHlBalances(user: `0x${string}` | undefined, mode: HlMode | undefined) {
  return useQuery({
    queryKey: ['hl-balances', user, mode],
    enabled: !!user && !!mode,
    refetchInterval: 6_000,
    staleTime: 3_000,
    retry: 1,
    queryFn: async () => {
      const [xyz, main, spot] = await Promise.all([info.clearinghouseState({ user: user!, dex: HL_DEX }), info.clearinghouseState({ user: user! }), info.spotClearinghouseState({ user: user! })]);
      return readBalances(mode!, xyz, main, spot);
    },
  });
}

/** The mid price of `coin` on the xyz dex every 5 s (allMids, weight 2): what orders are priced from. */
export function useHlMid(coin: string | null) {
  return useQuery({
    queryKey: ['hl-mids'],
    enabled: !!coin,
    refetchInterval: 5_000,
    staleTime: 2_500,
    retry: 1,
    queryFn: () => info.allMids({ dex: HL_DEX }),
    select: (mids: Record<string, string>) => {
      const v = coin ? mids[coin] : undefined;
      return typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? v : null;
    },
  });
}

export interface HlFill {
  coin: string;
  symbol: string;
  px: string;
  sz: string;
  /** Hyperliquid's direction, e.g. "Open Long", "Close Short", "Long > Short". */
  dir: string;
  closedPnl: string;
  fee: string;
  time: number;
  oid: number;
}

/** The Velum markets' fills from a userFills answer, newest first (pure, for tests). */
export function readFills(list: unknown): HlFill[] {
  if (!Array.isArray(list)) return [];
  const out: HlFill[] = [];
  for (const f of list as Array<Record<string, unknown>>) {
    if (!f || typeof f.coin !== 'string' || typeof f.px !== 'string' || typeof f.sz !== 'string' || typeof f.time !== 'number') continue;
    const symbol = symbolOf(f.coin);
    if (!symbol) continue;
    out.push({ coin: f.coin, symbol, px: f.px, sz: f.sz, dir: String(f.dir ?? ''), closedPnl: String(f.closedPnl ?? '0'), fee: String(f.fee ?? '0'), time: f.time, oid: typeof f.oid === 'number' ? f.oid : 0 });
  }
  return out.sort((a, b) => b.time - a.time);
}

/** The user's recent fills in the Velum markets (userFills, weight 20: once a minute, only while shown). */
export function useHlFills(user: `0x${string}` | undefined, shown: boolean) {
  return useQuery({
    queryKey: ['hl-fills', user],
    enabled: !!user && shown,
    refetchInterval: 60_000,
    staleTime: 20_000,
    retry: 1,
    queryFn: async () => readFills(await info.userFills({ user: user!, aggregateByTime: true })),
  });
}

/** A fresh mark price and leverage setting for `coin` right before an order. */
export async function freshAsset(user: `0x${string}`, coin: string) {
  return info.activeAssetData({ user, coin });
}

/** The connected wallet, refusing when it now holds another account than `user`. */
export async function userWallet(user: `0x${string}`) {
  const c = getConnection(wagmiConfig);
  if (c.status !== 'connected' || c.address.toLowerCase() !== user.toLowerCase()) throw new Error('Your wallet switched to another account. Reconnect the account you trade with.');
  return getWalletClient(wagmiConfig);
}

/** Approves a fresh agent with the user's own wallet (one EIP-712 signature, no gas), then stores it in this browser. */
export async function approveNewAgent(user: `0x${string}`): Promise<StoredAgent> {
  const wallet = await userWallet(user);
  const agent = newAgent(user);
  const ex = new ExchangeClient({ transport, wallet: wallet as never });
  await ex.approveAgent({ agentAddress: agent.address, agentName: agent.name });
  const stored: StoredAgent = { user: agent.user, address: agent.address, pk: agent.pk, validUntil: agent.validUntil };
  saveAgent(stored);
  return stored;
}

/** Hyperliquid's maxFeeRate string of a builder fee in tenths of a basis point (10 -> "0.01%"). */
export const builderRate = (f: number): `${string}%` => `${(f / 1000).toFixed(4).replace(/\.?0+$/, '')}%`;

/** Whether the user already allows `b`'s fee (Hyperliquid refuses orders with a builder fee above the approved one). */
export async function builderApproved(user: `0x${string}`, b: Builder): Promise<boolean> {
  return (await info.maxBuilderFee({ user, builder: b.b })) >= b.f;
}

/** The user's wallet approves Velum's builder fee (only when the build sets one; one EIP-712 signature, no gas). */
export async function approveBuilder(user: `0x${string}`, b: Builder): Promise<void> {
  const wallet = await userWallet(user);
  await new ExchangeClient({ transport, wallet: wallet as never }).approveBuilderFee({ builder: b.b, maxFeeRate: builderRate(b.f) });
}

/** An exchange client that signs with the stored agent. */
export const agentClient = (agent: StoredAgent) => new ExchangeClient({ transport, wallet: privateKeyToAccount(agent.pk) });

/** Moves USDC from the main perp balance to the xyz dex (standard accounts), signed by the agent. */
export async function moveToXyz(agent: StoredAgent, amount: string) {
  return agentClient(agent).agentSendAsset({ destination: agent.user, sourceDex: '', destinationDex: HL_DEX, token: HL_USDC_TOKEN, amount, fromSubAccount: '' });
}

/** Moves USDC from the xyz dex back to the main perp balance (standard accounts, before a withdrawal), signed by the agent. */
export async function moveFromXyz(agent: StoredAgent, amount: string) {
  return agentClient(agent).agentSendAsset({ destination: agent.user, sourceDex: HL_DEX, destinationDex: '', token: HL_USDC_TOKEN, amount, fromSubAccount: '' });
}

/** An exchange client that signs with the user's own wallet (withdrawals); `nonce` pins the action's nonce (Relay's). */
export async function userExchange(user: `0x${string}`, nonce?: number) {
  const wallet = await userWallet(user);
  return new ExchangeClient({ transport, wallet: wallet as never, ...(nonce !== undefined ? { nonceManager: () => nonce } : {}) });
}

/** The account mode and balances read now (a step about to move money re-reads them instead of trusting the dialog's). */
export async function freshBalances(user: `0x${string}`): Promise<{ mode: HlMode; bal: HlBalances }> {
  const mode = modeOf(await info.userAbstraction({ user }));
  const [xyz, main, spot] = await Promise.all([info.clearinghouseState({ user, dex: HL_DEX }), info.clearinghouseState({ user }), info.spotClearinghouseState({ user })]);
  return { mode, bal: readBalances(mode, xyz, main, spot) };
}
