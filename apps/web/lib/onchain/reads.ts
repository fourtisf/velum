'use client';
/**
 * Chain reads for the real (Phase 3) mode, as react-query hooks: token decimals and protocol constants,
 * the account's vault and wallet balances, allowances and module approvals, the launch guard, oracle
 * prices, the offer book, pools and positions. Every read goes through the app's read RPC (lib/chain.ts;
 * JSON-RPC batched), never the wallet. Positions come from the API's index plus the ids this browser keeps
 * (and, when the index cannot be used, a scan of the newest positions), with the chain as the source of truth
 * for each one; activity comes from the index once the API has confirmed the deployment.
 */
import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { api, type ActivityDTO, type PositionDTO } from '../api';
import { publicClient } from '../chain';
import { BOOK_ABI, ERC20_ABI, ORACLE_ABI, PERPS_ABI, SPOT_ABI, VAULT_ABI } from './abi';
import type { Deployment, OnchainInfo } from './deployment';
import { roundTrip, type PoolState } from './quote';

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
  /** Largest insurance top-up of a liquidator's reward (1 USDG). */
  rewardCap: bigint;
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
      const [valueScale, minPositionSize, bond, exitDelay, rewardCap] = await Promise.all([
        client.readContract({ address: p, abi: PERPS_ABI, functionName: 'valueScale' }),
        client.readContract({ address: p, abi: PERPS_ABI, functionName: 'minPositionSize' }),
        client.readContract({ address: p, abi: PERPS_ABI, functionName: 'FORCED_EXIT_BOND' }),
        client.readContract({ address: p, abi: PERPS_ABI, functionName: 'FORCED_EXIT_DELAY' }),
        client.readContract({ address: p, abi: PERPS_ABI, functionName: 'keeperRewardCap' }),
      ]);
      const decimals = Object.fromEntries(syms.map((s, i) => [s, Number(decs[i])]));
      for (const [s, v] of Object.entries(decimals)) if (!Number.isInteger(v) || v < 0 || v > 18) throw new Error(`${s} has unsupported decimals ${v}`);
      return { decimals, valueScale, minPositionSize, bond, exitDelay, rewardCap };
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

/**
 * The offer book has no per-market index on chain (and the API has none), so the web pages through it from the
 * newest id down (web audit W3-09). Offers that can never fill again are remembered per book and never read
 * again: inactive (withdrawn) or expired ones, and dust (backing below the maker margin of the smallest
 * position, or a largest fill below it: backing only shrinks and the largest fill is fixed). So an attacker
 * cannot push real offers out of view with cheap dust: each refresh reads at most OFFER_READS offers, new ids
 * first, then the live ones, then further down the book, and keeps going on the next refresh until it reaches
 * the bottom. Dust offers of the signed-in maker are still listed (and re-read) so they can be withdrawn.
 */
export const OFFER_READS = 1500;
/** Offers read in one JSON-RPC batch. */
const OFFER_PAGE = 250;

interface BookCache {
  /** Inactive or expired: never read again. */
  dead: Set<string>;
  /** Too small to fill any position: kept for their maker's list, re-read only for that maker. */
  dust: Map<string, Offer>;
  /** Fillable offers as last read. */
  live: Map<string, Offer>;
  /** Every id at or above `top` is unread; every id below `low` is unread (between them: classified). */
  top: bigint;
  low: bigint;
}
const books = new Map<string, BookCache>();

/** The smallest maker margin and fill an offer needs to back the smallest position (S/maxL of minPositionSize). */
export function offerFloor(minPositionSize: bigint): { backing: bigint; fill: bigint } {
  return { backing: (minPositionSize * 2000n + 9999n) / 10_000n, fill: minPositionSize };
}

/** How an offer read now is kept: dead (never again), dust (too small to fill anything) or live. Pure. */
export function offerClass(o: Offer, now: bigint, floor: { backing: bigint; fill: bigint }): 'dead' | 'dust' | 'live' {
  if (!o.active || o.expiry <= now) return 'dead';
  if (o.backing < floor.backing || o.largestFill < floor.fill) return 'dust';
  return 'live';
}

/**
 * The fillable offers (paged from the newest, see above), the maker's own dust offers, and the chain time. Once the
 * protocol constants are read (the dust floor needs minPositionSize). While the scan has not reached the bottom
 * of the book it continues every second, then every 15 s.
 */
export function useOfferBook(oc: OnchainInfo | null, addr: Address | undefined, minPositionSize: bigint | undefined) {
  return useQuery({
    queryKey: ['oc-offers', oc?.d.contracts.makerBook, addr?.toLowerCase() ?? null, minPositionSize?.toString() ?? null],
    enabled: !!oc && minPositionSize !== undefined,
    refetchInterval: (q) => (q.state.data && !q.state.data.complete ? 1000 : 15_000),
    staleTime: 4000,
    queryFn: () => readOffers(oc!.d, addr, minPositionSize!),
  });
}

export async function readOffers(d: Deployment, addr: Address | undefined, minPositionSize: bigint): Promise<{ offers: Offer[]; now: bigint; complete: boolean }> {
  const book = d.contracts.makerBook as A;
  const [next, block] = await Promise.all([client.readContract({ address: book, abi: BOOK_ABI, functionName: 'nextOfferId' }), client.getBlock({ blockTag: 'latest' })]);
  const now = block.timestamp;
  const floor = offerFloor(minPositionSize);
  const key = `${book}:${floor.backing}`;
  const c = books.get(key) ?? { dead: new Set<string>(), dust: new Map<string, Offer>(), live: new Map<string, Offer>(), top: next, low: next };
  books.set(key, c);
  const me = addr?.toLowerCase();
  const want: bigint[] = [];
  const seen = new Set<string>();
  const add = (id: bigint) => {
    const k = id.toString();
    if (want.length < OFFER_READS && !c.dead.has(k) && !seen.has(k)) {
      seen.add(k);
      want.push(id);
    }
  };
  for (let i = next - 1n; i >= c.top && i >= 1n; i--) add(i);
  for (const o of c.live.values()) add(o.id);
  if (me) for (const o of c.dust.values()) if (o.maker.toLowerCase() === me) add(o.id);
  let low = c.low;
  while (low > 1n && want.length < OFFER_READS) {
    low--;
    add(low);
  }
  for (let i = 0; i < want.length; i += OFFER_PAGE) {
    const page = want.slice(i, i + OFFER_PAGE);
    const rows = await Promise.all(page.map((id) => client.readContract({ address: book, abi: BOOK_ABI, functionName: 'offers', args: [id] })));
    rows.forEach(([maker, market, backing, largestFill, openBps, closeBps, expiry, active], j) => {
      const o: Offer = { id: page[j]!, maker, market, backing, largestFill, openBps, closeBps, expiry, active };
      const k = o.id.toString();
      c.live.delete(k);
      c.dust.delete(k);
      const cls = offerClass(o, now, floor);
      if (cls === 'dead') c.dead.add(k);
      else (cls === 'dust' ? c.dust : c.live).set(k, o);
    });
  }
  if (next > c.top) c.top = next;
  c.low = low;
  const mine = me ? [...c.dust.values()].filter((o) => o.maker.toLowerCase() === me) : [];
  return { offers: [...c.live.values(), ...mine], now, complete: low <= 1n };
}

/** What ranking can use to price an offer exactly (else it compares spreads). */
export interface RankCtx {
  price: bigint;
  levHalf: number;
  long: boolean;
  valueScale: bigint;
}

/** Offers that can fill `size` on `market` for `taker`: active, unexpired, not the taker's own, large enough (largestFill, and backing for the S/maxL maker margin). */
export function fittingOffers(offers: readonly Offer[], market: string, size: bigint, taker: string | undefined, now: bigint): Offer[] {
  const need = (size * 2000n + 9999n) / 10_000n;
  return offers.filter(
    (o) => o.active && o.market.toLowerCase() === market.toLowerCase() && o.expiry > now + 30n && o.largestFill >= size && o.backing >= need && (!taker || o.maker.toLowerCase() !== taker.toLowerCase()),
  );
}

/**
 * The offers that can fill `size`, cheapest first by the whole round trip (web audit W3-03): open spread plus
 * close spread plus fees, priced exactly (roundTrip) when the oracle price and constants are known, else by the
 * two spreads. A 2 bps open / 500 bps close offer therefore ranks far behind a 5 / 5 one. Ties: the lower close
 * spread, then the oldest offer.
 */
export function rankOffers(offers: readonly Offer[], market: string, size: bigint, taker: string | undefined, now: bigint, ctx?: RankCtx | null): Offer[] {
  const fit = fittingOffers(offers, market, size, taker, now);
  const ref = size > 0n ? size : 1000n * 10n ** 6n;
  const cost = (o: Offer): bigint | null => (ctx && ctx.price > 0n ? roundTrip({ price: ctx.price, size: ref, levHalf: ctx.levHalf, long: ctx.long, openBps: o.openBps, closeBps: o.closeBps, valueScale: ctx.valueScale }).total : null);
  const keyed = fit.map((o) => ({ o, c: cost(o) }));
  keyed.sort((a, b) => {
    if (a.c !== null && b.c !== null && a.c !== b.c) return a.c < b.c ? -1 : 1;
    const sa = a.o.openBps + a.o.closeBps;
    const sb = b.o.openBps + b.o.closeBps;
    return sa - sb || a.o.closeBps - b.o.closeBps || (a.o.id < b.o.id ? -1 : a.o.id > b.o.id ? 1 : 0);
  });
  return keyed.map((x) => x.o);
}

/** The cheapest offer for `size` by the whole round trip (rankOffers), or null when none fits. */
export function bestOffer(offers: readonly Offer[], market: string, size: bigint, taker: string | undefined, now: bigint, ctx?: RankCtx | null): Offer | null {
  return rankOffers(offers, market, size, taker, now, ctx)[0] ?? null;
}

/** How many of the cheapest offers the ticket lets the user choose from. */
export const OFFER_CHOICES = 3;

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

/** At most this many position ids are taken from one API answer (the request asks for 100; W3-05, W3-12). */
export const MAX_API_POSITIONS = 100;

/** Ids of the account's open positions from the API's index (both roles), with their open transaction. Capped. */
export function apiOpenPositions(body: unknown): Array<{ id: bigint; openTx: string | null }> {
  if (!Array.isArray(body)) return [];
  const out: Array<{ id: bigint; openTx: string | null }> = [];
  for (const p of body.slice(0, MAX_API_POSITIONS) as Partial<PositionDTO>[]) {
    if (!p || typeof p.id !== 'string' || !POS_ID.test(p.id) || p.status !== 'open') continue;
    out.push({ id: BigInt(p.id), openTx: typeof p.openTx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(p.openTx) ? p.openTx : null });
  }
  return out;
}

/**
 * Position ids this browser knows for the account (opened here, or seen open in the index), kept in
 * localStorage per chain, deployment and account (W3-05) and re-read from the chain on every refresh: the
 * account's positions stay visible, closable and force-exitable while the API is down or out of step.
 * Untrusted input like any storage: ids are validated, capped, and each one is checked on chain.
 */
export const MAX_KNOWN_POSITIONS = 200;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
export const positionsKey = (d: Deployment, addr: string) => `velum:oc-positions:v1:${d.chainId}:${d.contracts.perpsMarkets}:${addr.toLowerCase()}`;
const memory = new Map<string, Map<string, string | null>>();

export function loadKnown(d: Deployment, addr: string): Map<string, string | null> {
  const k = positionsKey(d, addr);
  const out = new Map<string, string | null>(memory.get(k) ?? []);
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(k) || '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
      for (const [id, tx] of Object.entries(raw).slice(0, MAX_KNOWN_POSITIONS)) if (POS_ID.test(id) && !out.has(id)) out.set(id, typeof tx === 'string' && HASH_RE.test(tx) ? tx : null);
  } catch {
    /* storage unavailable or malformed: memory only */
  }
  return out;
}

function saveKnown(d: Deployment, addr: string, m: Map<string, string | null>) {
  const k = positionsKey(d, addr);
  const kept = new Map([...m].sort((a, b) => (BigInt(a[0]) > BigInt(b[0]) ? -1 : 1)).slice(0, MAX_KNOWN_POSITIONS));
  memory.set(k, kept);
  try {
    localStorage.setItem(k, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* storage unavailable: memory only */
  }
}

/** A position this browser just opened (the index stays a few blocks behind). */
export function rememberPosition(oc: OnchainInfo, addr: string, id: bigint, tx: string | null) {
  const m = loadKnown(oc.d, addr);
  m.set(id.toString(), tx);
  saveKnown(oc.d, addr, m);
}

/**
 * When the index cannot be used (the API failed, or serves another deployment), the newest positions are read
 * from the chain to find the account's: SCAN_POSITIONS ids back from the newest on the first refresh, then only
 * the new ones. Positions are never re-scanned (their taker and maker never change).
 */
export const SCAN_POSITIONS = 2000;
const SCAN_PAGE = 250;
const scans = new Map<string, { top: bigint; low: bigint; mine: Set<string> }>();

async function scanPositions(d: Deployment, addr: Address): Promise<string[]> {
  const perps = d.contracts.perpsMarkets as A;
  const next = await client.readContract({ address: perps, abi: PERPS_ABI, functionName: 'nextPositionId' });
  const key = `${perps}:${addr.toLowerCase()}`;
  const st = scans.get(key) ?? { top: next, low: next, mine: new Set<string>() };
  scans.set(key, st);
  const floor = next > BigInt(SCAN_POSITIONS) ? next - BigInt(SCAN_POSITIONS) : 1n;
  const ids: bigint[] = [];
  for (let i = next - 1n; i >= st.top && i >= 1n; i--) ids.push(i);
  for (let i = st.low - 1n; i >= floor && i >= 1n; i--) ids.push(i);
  const me = addr.toLowerCase();
  for (let i = 0; i < ids.length; i += SCAN_PAGE) {
    const page = ids.slice(i, i + SCAN_PAGE);
    const rows = await Promise.all(page.map((id) => client.readContract({ address: perps, abi: PERPS_ABI, functionName: 'getPosition', args: [id] })));
    rows.forEach((p, j) => {
      if (p.open && (p.taker.toLowerCase() === me || p.maker.toLowerCase() === me)) st.mine.add(page[j]!.toString());
    });
  }
  if (next > st.top) st.top = next;
  if (floor < st.low) st.low = floor;
  return [...st.mine];
}

export interface PositionsRead {
  list: ChainPosition[];
  /** The API's index could not be used (unreachable, erroring, or for another deployment). */
  indexError: boolean;
}

export function useChainPositions(oc: OnchainInfo | null, addr: Address | undefined) {
  return useQuery({
    queryKey: ['oc-positions', oc?.d.contracts.perpsMarkets, addr, oc?.status === 'mismatch'],
    enabled: !!oc && !!addr,
    refetchInterval: 6000,
    staleTime: 2000,
    queryFn: () => readPositions(oc!, addr!),
  });
}

export async function readPositions(oc: OnchainInfo, addr: Address): Promise<PositionsRead> {
  const d = oc.d;
  let indexError = oc.status === 'mismatch';
  let fromApi: Array<{ id: bigint; openTx: string | null }> = [];
  if (!indexError) {
    try {
      fromApi = apiOpenPositions(await api.positions(addr, 'open'));
    } catch {
      indexError = true;
    }
  }
  const known = loadKnown(d, addr);
  const ids = new Map<string, string | null>(fromApi.map((p) => [p.id.toString(), p.openTx]));
  for (const [id, tx] of known) if (!ids.has(id)) ids.set(id, tx);
  if (indexError) for (const id of await scanPositions(d, addr)) if (!ids.has(id)) ids.set(id, null);
  const symOf = new Map(Object.entries(d.tokens).map(([s, a]) => [a.toLowerCase(), s]));
  const me = addr.toLowerCase();
  const list = await Promise.all(
    [...ids].map(async ([id, tx]) => {
      const p = await client.readContract({ address: d.contracts.perpsMarkets as A, abi: PERPS_ABI, functionName: 'getPosition', args: [BigInt(id)] });
      const role = p.taker.toLowerCase() === me ? 'taker' : p.maker.toLowerCase() === me ? 'maker' : null;
      const sym = symOf.get(p.market.toLowerCase());
      if (!p.open || !role || !sym) return null;
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
        openTx: tx ?? known.get(id) ?? null,
      } satisfies ChainPosition;
    }),
  );
  const open = list.filter((x): x is ChainPosition => x !== null).sort((a, b) => (a.id > b.id ? -1 : 1));
  // Keep exactly the open positions confirmed on chain (closed, foreign or malformed ids are dropped).
  saveKnown(d, addr, new Map(open.map((p) => [p.id.toString(), p.openTx])));
  return { list: open, indexError };
}

/**
 * The account's activity from the API's index, newest first (validated item by item). Only once the API has
 * confirmed this build's deployment: an index of other contracts would describe someone else's history.
 */
export function useOnchainActivity(oc: OnchainInfo | null, addr: Address | undefined) {
  return useQuery({
    queryKey: ['oc-activity', oc?.d.contracts.perpsMarkets, addr],
    enabled: !!oc?.verified && !!addr,
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
