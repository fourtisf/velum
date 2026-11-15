'use client';
/**
 * Chain reads for the real (Phase 3) mode, as react-query hooks: token decimals and protocol constants,
 * the account's vault and wallet balances, allowances and module approvals, the launch guard, oracle
 * prices, the offer book, pools and positions. Every read goes through the app's read RPC (lib/chain.ts;
 * JSON-RPC batched), never the wallet. Positions and activity come from the API's index, with the chain
 * as the source of truth for each open position's current state.
 */
import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { api, type ActivityDTO, type PositionDTO } from '../api';
import { publicClient } from '../chain';
import { BOOK_ABI, ERC20_ABI, ORACLE_ABI, PERPS_ABI, SPOT_ABI, VAULT_ABI } from './abi';
import type { Deployment, OnchainInfo } from './deployment';
import type { PoolState } from './quote';

const client = publicClient;
type A = `0x${string}`;

/** Module names as the contracts list them, and their deployment keys. */
export const MODULES = { perps: 'perpsMarkets', spot: 'spotPools', book: 'makerBook' } as const;
export type ModuleKey = keyof typeof MODULES;

export interface Protocol {
  /** Decimals by symbol, read from each token. */
  decimals: Record<string, number>;
  valueScale: bigint;
  minPositionSize: bigint;
  bond: bigint;
  exitDelay: bigint;
}

/** Decimals of every deployment token and the perps constants. Read once per deployment. */
export function useProtocol(oc: OnchainInfo | null) {
  return useQuery({
    queryKey: ['oc-protocol', oc?.d.contracts.perpsMarkets],
    enabled: !!oc,
    staleTime: Infinity,
    retry: 3,
    queryFn: async (): Promise<Protocol> => {
      const d = oc!.d;
      const syms = Object.keys(d.tokens);
      const decs = await Promise.all(syms.map((s) => client.readContract({ address: d.tokens[s] as A, abi: ERC20_ABI, functionName: 'decimals' })));
      const p = d.contracts.perpsMarkets as A;
      const [valueScale, minPositionSize, bond, exitDelay] = await Promise.all([
        client.readContract({ address: p, abi: PERPS_ABI, functionName: 'valueScale' }),
        client.readContract({ address: p, abi: PERPS_ABI, functionName: 'minPositionSize' }),
        client.readContract({ address: p, abi: PERPS_ABI, functionName: 'FORCED_EXIT_BOND' }),
        client.readContract({ address: p, abi: PERPS_ABI, functionName: 'FORCED_EXIT_DELAY' }),
      ]);
      const decimals = Object.fromEntries(syms.map((s, i) => [s, Number(decs[i])]));
      for (const [s, v] of Object.entries(decimals)) if (!Number.isInteger(v) || v < 0 || v > 18) throw new Error(`${s} has unsupported decimals ${v}`);
      return { decimals, valueScale, minPositionSize, bond, exitDelay };
    },
  });
}

export interface AccountState {
  /** Free vault balance by symbol (base units). */
  vault: Record<string, bigint>;
  /** Wallet (ERC-20) balance by symbol (base units). */
  wallet: Record<string, bigint>;
  /** ERC-20 allowance to the vault by symbol. */
  allowance: Record<string, bigint>;
  /** Module approvals in the vault. */
  approved: Record<ModuleKey, boolean>;
  eth: bigint;
  /** Unclaimed forced-exit bond refunds (wei). */
  bondRefund: bigint;
}

export function useAccountState(oc: OnchainInfo | null, addr: Address | undefined) {
  return useQuery({
    queryKey: ['oc-account', oc?.d.contracts.vault, addr],
    enabled: !!oc && !!addr,
    refetchInterval: 6000,
    staleTime: 2000,
    queryFn: () => readAccount(oc!.d, addr!),
  });
}

export async function readAccount(d: Deployment, addr: Address): Promise<AccountState> {
  const syms = Object.keys(d.tokens);
  const vaultAddr = d.contracts.vault as A;
  const [vault, wallet, allowance, approvals, eth, bondRefund] = await Promise.all([
    Promise.all(syms.map((s) => client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: 'balanceOf', args: [addr, d.tokens[s] as A] }))),
    Promise.all(syms.map((s) => client.readContract({ address: d.tokens[s] as A, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] }))),
    Promise.all(syms.map((s) => client.readContract({ address: d.tokens[s] as A, abi: ERC20_ABI, functionName: 'allowance', args: [addr, vaultAddr] }))),
    Promise.all((Object.keys(MODULES) as ModuleKey[]).map((m) => client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: 'approved', args: [addr, d.contracts[MODULES[m]] as A] }))),
    client.getBalance({ address: addr }),
    client.readContract({ address: d.contracts.perpsMarkets as A, abi: PERPS_ABI, functionName: 'bondRefunds', args: [addr] }),
  ]);
  const by = (v: readonly bigint[]) => Object.fromEntries(syms.map((s, i) => [s, v[i]!]));
  const keys = Object.keys(MODULES) as ModuleKey[];
  return {
    vault: by(vault),
    wallet: by(wallet),
    allowance: by(allowance),
    approved: Object.fromEntries(keys.map((k, i) => [k, approvals[i]!])) as Record<ModuleKey, boolean>,
    eth,
    bondRefund,
  };
}

export interface GuardState {
  /** Allowlist or caps active (the vault's guarded()). */
  guarded: boolean;
  allowlistActive: boolean;
  capsActive: boolean;
  guardAdmin: Address;
  /** The account is on the allowlist (meaningful while the allowlist is active). */
  allowlisted: boolean;
  /** The most the account can deposit for itself now, by symbol (type(uint256).max when uncapped). */
  depositLimit: Record<string, bigint>;
}

export function useGuard(oc: OnchainInfo | null, addr: Address | undefined) {
  return useQuery({
    queryKey: ['oc-guard', oc?.d.contracts.vault, addr],
    enabled: !!oc,
    refetchInterval: 20_000,
    staleTime: 5000,
    queryFn: () => readGuard(oc!.d, addr),
  });
}

export async function readGuard(d: Deployment, addr: Address | undefined): Promise<GuardState> {
  const v = d.contracts.vault as A;
  const syms = Object.keys(d.tokens);
  const [guarded, allowlistActive, capsActive, guardAdmin] = await Promise.all([
    client.readContract({ address: v, abi: VAULT_ABI, functionName: 'guarded' }),
    client.readContract({ address: v, abi: VAULT_ABI, functionName: 'allowlistActive' }),
    client.readContract({ address: v, abi: VAULT_ABI, functionName: 'capsActive' }),
    client.readContract({ address: v, abi: VAULT_ABI, functionName: 'guardAdmin' }),
  ]);
  if (!addr) return { guarded, allowlistActive, capsActive, guardAdmin, allowlisted: false, depositLimit: {} };
  const [allowlisted, limits] = await Promise.all([
    client.readContract({ address: v, abi: VAULT_ABI, functionName: 'isAllowlisted', args: [addr] }),
    Promise.all(syms.map((s) => client.readContract({ address: v, abi: VAULT_ABI, functionName: 'depositLimit', args: [addr, d.tokens[s] as A] }))),
  ]);
  return { guarded, allowlistActive, capsActive, guardAdmin, allowlisted, depositLimit: Object.fromEntries(syms.map((s, i) => [s, limits[i]!])) };
}

export interface OraclePrice {
  /** Effective price (USDG per token x 1e18) a recording now would report. */
  price: bigint;
  /** Source timestamp of that price (chain seconds). */
  updatedAt: bigint;
  /** Latest block time (chain seconds). */
  now: bigint;
  lagging: boolean;
  closeOnly: boolean;
  /** Funding rate per hour, 1e18 = 100% (positive: longs pay shorts). */
  fundingRate: bigint;
}

/** The oracle's price for `sym` (what the contracts use), polled. Null while unknown or unpriced. */
export function useOraclePrice(oc: OnchainInfo | null, sym: string | null) {
  const token = sym && oc ? oc.d.tokens[sym] : undefined;
  return useQuery({
    queryKey: ['oc-oracle', oc?.d.contracts.oracle, sym],
    enabled: !!token,
    refetchInterval: 2500,
    staleTime: 1000,
    queryFn: () => readOracle(oc!.d, sym!),
  });
}

export async function readOracle(d: Deployment, sym: string): Promise<OraclePrice | null> {
  const token = d.tokens[sym] as A | undefined;
  if (!token) return null;
  try {
    const [[price, updatedAt], lagging, block, closeOnly, market] = await Promise.all([
      client.readContract({ address: d.contracts.oracle as A, abi: ORACLE_ABI, functionName: 'latest', args: [token] }),
      client.readContract({ address: d.contracts.oracle as A, abi: ORACLE_ABI, functionName: 'lagging', args: [token] }),
      client.getBlock({ blockTag: 'latest' }),
      client.readContract({ address: d.contracts.perpsMarkets as A, abi: PERPS_ABI, functionName: 'closeOnly', args: [token] }),
      client.readContract({ address: d.contracts.perpsMarkets as A, abi: PERPS_ABI, functionName: 'markets', args: [token] }),
    ]);
    return { price, updatedAt, now: block.timestamp, lagging, closeOnly, fundingRate: market[5] };
  } catch {
    // NoPrice: the relay has not pushed this market yet.
    return null;
  }
}

/** Seconds a price may be old for an open, margin removal or forced-exit settlement (OPEN_MAX_AGE), and for a close (MAX_PRICE_AGE). */
export const PRICE_AGE = { open: 10n, close: 60n } as const;

/** Whether an oracle reading can be traded on for `use` right now (fresh enough and not lagging). */
export function priceUsable(p: OraclePrice | null | undefined, use: keyof typeof PRICE_AGE): boolean {
  return !!p && p.price > 0n && !p.lagging && p.now - p.updatedAt <= PRICE_AGE[use];
}

export interface Offer {
  id: bigint;
  maker: Address;
  market: Address;
  backing: bigint;
  largestFill: bigint;
  openBps: number;
  closeBps: number;
  expiry: bigint;
  active: boolean;
}

/** How many of the newest offers the web scans (the book has no per-market index on chain). */
export const OFFER_SCAN = 120;

/** The newest OFFER_SCAN offers, read from the maker book. */
export function useOfferBook(oc: OnchainInfo | null) {
  return useQuery({
    queryKey: ['oc-offers', oc?.d.contracts.makerBook],
    enabled: !!oc,
    refetchInterval: 15_000,
    staleTime: 4000,
    queryFn: () => readOffers(oc!.d),
  });
}

export async function readOffers(d: Deployment): Promise<{ offers: Offer[]; now: bigint }> {
  const book = d.contracts.makerBook as A;
  const [next, block] = await Promise.all([client.readContract({ address: book, abi: BOOK_ABI, functionName: 'nextOfferId' }), client.getBlock({ blockTag: 'latest' })]);
  const ids: bigint[] = [];
  for (let i = next - 1n; i >= 1n && ids.length < OFFER_SCAN; i--) ids.push(i);
  const rows = await Promise.all(ids.map((id) => client.readContract({ address: book, abi: BOOK_ABI, functionName: 'offers', args: [id] })));
  const offers = rows.map(([maker, market, backing, largestFill, openBps, closeBps, expiry, active], i) => ({ id: ids[i]!, maker, market, backing, largestFill, openBps, closeBps, expiry, active }));
  return { offers, now: block.timestamp };
}

/**
 * The offer a taker opening `size` (USDG base units) on `market` is filled by: active, unexpired, on that
 * market, not the taker's own, large enough (largestFill and backing for the S/maxL maker margin), with the
 * lowest open spread (best entry); ties go to the oldest. Null when none fits.
 */
export function bestOffer(offers: readonly Offer[], market: string, size: bigint, taker: string | undefined, now: bigint): Offer | null {
  const need = (size * 2000n + 9999n) / 10_000n;
  const fit = offers.filter(
    (o) => o.active && o.market.toLowerCase() === market.toLowerCase() && o.expiry > now + 30n && o.largestFill >= size && o.backing >= need && (!taker || o.maker.toLowerCase() !== taker.toLowerCase()),
  );
  fit.sort((a, b) => a.openBps - b.openBps || (a.id < b.id ? -1 : 1));
  return fit[0] ?? null;
}

/** The best offer on `market` whatever the size (for the ticket's quote before a size is typed). */
export function bestSpread(offers: readonly Offer[], market: string, taker: string | undefined, now: bigint): Offer | null {
  return bestOffer(offers, market, 0n, taker, now);
}

export interface PoolRead extends PoolState {
  sym: string;
  /** The account's shares (0 without an account). */
  mine: bigint;
}

export function usePools(oc: OnchainInfo | null, addr: Address | undefined) {
  return useQuery({
    queryKey: ['oc-pools', oc?.d.contracts.spotPools, addr],
    enabled: !!oc,
    refetchInterval: 10_000,
    staleTime: 3000,
    queryFn: () => readPools(oc!.d, oc!.markets, addr),
  });
}

export async function readPools(d: Deployment, markets: string[], addr: Address | undefined): Promise<Record<string, PoolRead>> {
  const sp = d.contracts.spotPools as A;
  const rows = await Promise.all(
    markets.map(async (sym) => {
      const token = d.tokens[sym] as A;
      const [[stockReserve, usdgReserve, totalShares], mine] = await Promise.all([
        client.readContract({ address: sp, abi: SPOT_ABI, functionName: 'pools', args: [token] }),
        addr ? client.readContract({ address: sp, abi: SPOT_ABI, functionName: 'sharesOf', args: [token, addr] }) : Promise.resolve(0n),
      ]);
      return [sym, { sym, stockReserve, usdgReserve, totalShares, mine }] as const;
    }),
  );
  return Object.fromEntries(rows);
}

/** One open position the account is a party to, as the chain has it now. */
export interface ChainPosition {
  id: bigint;
  sym: string;
  role: 'taker' | 'maker';
  long: boolean;
  levHalf: number;
  closeBps: number;
  qty: bigint;
  entry: bigint;
  takerMargin: bigint;
  makerMargin: bigint;
  openedAt: bigint;
  exitRequestedAt: bigint;
  exitRequester: Address;
  openTx: string | null;
}

const POS_ID = /^\d{1,30}$/;

/** Ids of the account's open positions from the API's index (both roles), with their open transaction. */
export function apiOpenPositions(body: unknown): Array<{ id: bigint; openTx: string | null }> {
  if (!Array.isArray(body)) return [];
  const out: Array<{ id: bigint; openTx: string | null }> = [];
  for (const p of body as Partial<PositionDTO>[]) {
    if (!p || typeof p.id !== 'string' || !POS_ID.test(p.id) || p.status !== 'open') continue;
    out.push({ id: BigInt(p.id), openTx: typeof p.openTx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(p.openTx) ? p.openTx : null });
  }
  return out;
}

/** Position ids this browser opened and the index may not show yet (it stays a few blocks behind). */
const recent = new Map<string, Map<string, string | null>>();
export function rememberPosition(addr: string, id: bigint, tx: string | null) {
  const k = addr.toLowerCase();
  if (!recent.has(k)) recent.set(k, new Map());
  recent.get(k)!.set(id.toString(), tx);
}

export function useChainPositions(oc: OnchainInfo | null, addr: Address | undefined) {
  return useQuery({
    queryKey: ['oc-positions', oc?.d.contracts.perpsMarkets, addr],
    enabled: !!oc && !!addr,
    refetchInterval: 6000,
    staleTime: 2000,
    queryFn: () => readPositions(oc!.d, addr!),
  });
}

export async function readPositions(d: Deployment, addr: Address): Promise<ChainPosition[]> {
  const fromApi = apiOpenPositions(await api.positions(addr, 'open').catch(() => []));
  const ids = new Map<string, string | null>(fromApi.map((p) => [p.id.toString(), p.openTx]));
  for (const [id, tx] of recent.get(addr.toLowerCase()) ?? []) if (!ids.has(id)) ids.set(id, tx);
  const symOf = new Map(Object.entries(d.tokens).map(([s, a]) => [a.toLowerCase(), s]));
  const list = await Promise.all(
    [...ids].map(async ([id, tx]) => {
      const p = await client.readContract({ address: d.contracts.perpsMarkets as A, abi: PERPS_ABI, functionName: 'getPosition', args: [BigInt(id)] });
      const me = addr.toLowerCase();
      const role = p.taker.toLowerCase() === me ? 'taker' : p.maker.toLowerCase() === me ? 'maker' : null;
      const sym = symOf.get(p.market.toLowerCase());
      if (!p.open || !role || !sym) {
        recent.get(me)?.delete(id);
        return null;
      }
      return {
        id: BigInt(id),
        sym,
        role,
        long: p.isLong,
        levHalf: p.leverageHalf,
        closeBps: p.closeSpreadBps,
        qty: p.qty,
        entry: p.entry,
        takerMargin: p.takerMargin,
        makerMargin: p.makerMargin,
        openedAt: p.openedAt,
        exitRequestedAt: p.exitRequestedAt,
        exitRequester: p.exitRequester,
        openTx: tx,
      } satisfies ChainPosition;
    }),
  );
  return list.filter((x): x is ChainPosition => x !== null).sort((a, b) => (a.id > b.id ? -1 : 1));
}

/** The account's activity from the API's index, newest first (validated item by item). */
export function useOnchainActivity(oc: OnchainInfo | null, addr: Address | undefined) {
  return useQuery({
    queryKey: ['oc-activity', oc?.d.contracts.perpsMarkets, addr],
    enabled: !!oc && !!addr,
    refetchInterval: 10_000,
    staleTime: 3000,
    queryFn: async () => apiActivity(await api.activity(addr!, 50)),
  });
}

export function apiActivity(body: unknown): ActivityDTO[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (x): x is ActivityDTO =>
      !!x && typeof x === 'object' && typeof (x as ActivityDTO).kind === 'string' && typeof (x as ActivityDTO).tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test((x as ActivityDTO).tx) && typeof (x as ActivityDTO).data === 'object' && (x as ActivityDTO).data !== null,
  );
}

/** The oracle price of every deployment market (for totals and asset values). */
export function useAllOracle(oc: OnchainInfo | null) {
  return useQuery({
    queryKey: ['oc-oracle-all', oc?.d.contracts.oracle],
    enabled: !!oc,
    refetchInterval: 5000,
    staleTime: 2000,
    queryFn: async () => Object.fromEntries(await Promise.all(oc!.markets.map(async (s) => [s, await readOracle(oc!.d, s)] as const))) as Record<string, OraclePrice | null>,
  });
}
