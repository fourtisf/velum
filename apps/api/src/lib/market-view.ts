import {
  DEMO,
  DEX_PARAMS,
  PROTOCOL,
  QUOTE_FROZEN_AFTER_MS,
  REAL_PRICE_SOURCES,
  dexPoolsOf,
  lastEndedSession,
  usEquitySession,
  type DexSnapshot,
  type MarketSeed,
  type MarketSnapshot,
  type NetworkName,
} from '@velum/config';
import { WAD, bps, maintenanceMargin, parseWad, toDecimalString, wdiv, wmul, type Wad } from '@velum/math';
import type { SessionCloses } from './session-change';

export const MAX_PRICE_AGE_MS = PROTOCOL.oracleMaxAgeSeconds * 1000;

/**
 * Why a price is not live (audit M-1):
 *  - noPrice      no snapshot (the workers have not priced the market yet)
 *  - unavailable  the cache could not be read (Redis down); the last known price is shown, not live
 *  - outdated     the workers have not confirmed the quote with the source for over MAX_PRICE_AGE_MS
 *  - demoSource   a simulated price on mainnet (never live there)
 *  - marketClosed the US-equity session for Stock Tokens is closed (weekend or US market holiday)
 *  - quoteFrozen  the source keeps repeating a quote that has not changed for QUOTE_FROZEN_AFTER_MS, or
 *                 price-relay started without a previous snapshot and has not yet seen the quote change
 *                 (snapshot `unconfirmed`, audit F-6: its quote time is unknown)
 * Simulated (demo) prices on testnet ignore the session calendar: they keep moving while closed.
 */
export type StaleReason = 'noPrice' | 'unavailable' | 'outdated' | 'demoSource' | 'marketClosed' | 'quoteFrozen';

export interface PriceState {
  /** True when the price must not be treated as live (clients: not tradable on mainnet). */
  stale: boolean;
  staleReason: StaleReason | null;
  /** Whether the 24/5 US-equity session for Stock Tokens is open now (weekends and US holidays closed). */
  marketOpen: boolean;
  /** Seconds since the quote last changed (the snapshot's quote time), null without a snapshot. */
  quoteAge: number | null;
}

export function priceState(snap: MarketSnapshot | undefined, now: number, network: NetworkName, cacheOk = true): PriceState {
  const marketOpen = usEquitySession(now).open;
  const quoteAge = snap ? Math.max(0, Math.floor((now - snap.updatedAt) / 1000)) : null;
  const stale = (staleReason: StaleReason | null): PriceState => ({ stale: staleReason !== null, staleReason, marketOpen, quoteAge });
  if (!cacheOk) return stale('unavailable');
  if (!snap) return stale('noPrice');
  if (snap.source === 'demo' && network === 'mainnet') return stale('demoSource');
  if (now - (snap.checkedAt ?? snap.updatedAt) > MAX_PRICE_AGE_MS) return stale('outdated');
  if (snap.source === 'demo') return stale(null);
  if (!marketOpen) return stale('marketClosed');
  if (snap.unconfirmed || now - snap.updatedAt > QUOTE_FROZEN_AFTER_MS) return stale('quoteFrozen');
  return stale(null);
}

export interface MarketView extends PriceState {
  symbol: string;
  name: string;
  token: string | null;
  status: MarketSeed['status'];
  price: string;
  mark: string;
  open24h: string;
  change24h: string;
  /** Demo value on testnet; null on mainnet until funding has a real source (Phase 3). */
  fundingPerHour: string | null;
  /** Demo value on testnet; null on mainnet until open interest has a real source (Phase 3). */
  openInterest: string | null;
  /** True when fundingPerHour and openInterest are simulated (testnet); the price's origin is `source`. */
  demo: boolean;
  maxLeverage: number;
  takerFeeBps: number;
  maintenanceMargin: string;
  spark: string[];
  /** Where the price came from: "demo" (simulated), "robinhood" or "chainlink". null before the first tick. */
  source: string | null;
  /** Quote time of the price (when it last changed), null before the first tick. */
  updatedAt: number | null;
  /**
   * The change to show, in percent with 2 decimals, on the basis `changeBasis`: the rolling 24 h change while the
   * market is open (equal to change24h); while it is closed, the last session's change (close vs the previous
   * session's close) or, with an on-chain DEX price, the DEX price vs the last session's close. null when stored
   * history does not hold both prices (never estimated).
   */
  change: string | null;
  changeBasis: ChangeBasis;
  /** While the market is closed (real prices): the last session and its change. null while open. */
  lastSession: LastSessionView | null;
  /** While the market is closed: the last on-chain DEX trade of the market's pool (display only, never tradable). */
  dex: DexView | null;
}

/** "24h": rolling 24 hours (market open). "lastSession": the last session's change. "dexSinceClose": DEX price vs the last close. */
export type ChangeBasis = '24h' | 'lastSession' | 'dexSinceClose';

export interface LastSessionView {
  /** The trading day (US Eastern) and when its session ended (20:00 ET, Unix ms). */
  tradingDay: string;
  end: number;
  /** Its close and the previous session's close (the last quote before 20:00 ET), null when not stored. */
  close: string | null;
  prevClose: string | null;
  /** close vs prevClose in percent (2 decimals), null without both. */
  change: string | null;
}

export interface DexView {
  /** Last on-chain trade that passed the guards: USDG per token (the basis of every Velum price). */
  price: string;
  /** price vs the pool's own price at the last session's close, in percent (2 decimals); null when it had no trade in the day before. */
  change: string | null;
  /** The pool's price at the last session's close (its last trade before 20:00 ET, within a day), and that trade's time. */
  closeRef: string | null;
  closeAt: number | null;
  tradeAt: number;
  block: number;
  /** The pool contract (Velum names no DEX) and the liquidity it holds in USDG. */
  pool: string;
  liquidityUsdg: string;
}

/** What the markets route adds to a market's view while the market is closed. */
export interface MarketExtras {
  closes?: SessionCloses | null;
  dex?: DexSnapshot | null;
}

const MM = toDecimalString(maintenanceMargin(PROTOCOL), 2);

/** 24h change in percent with 2 decimals. */
export function changePct(price: Wad, open: Wad): string {
  if (open <= 0n) return '0.00';
  return toDecimalString(wdiv((price - open) * 100n, open), 2);
}

/** a vs b in percent with 2 decimals, or null when either is missing or b is not positive. */
const pctOf = (a: string | null | undefined, b: string | null | undefined): string | null => {
  const x = a ? parseWad(a) : null;
  const y = b ? parseWad(b) : null;
  return x !== null && y !== null && y > 0n ? changePct(x, y) : null;
};

/**
 * The closed-market fields (session change, DEX price) of one market. Only for real prices: simulated prices on
 * testnet ignore the calendar and keep moving, so they keep the rolling 24 h change. The DEX price shows only while
 * the market is closed, for a configured pool above the liquidity threshold whose snapshot the workers confirmed
 * recently, and only for a trade made after the last session ended (otherwise the official close is newer).
 */
export function closedFields(
  seed: MarketSeed,
  snap: MarketSnapshot | undefined,
  now: number,
  network: NetworkName,
  extras: MarketExtras = {},
): Pick<MarketView, 'change' | 'changeBasis' | 'lastSession' | 'dex'> | null {
  if (usEquitySession(now).open) return null;
  const real = snap ? REAL_PRICE_SOURCES.includes(snap.source) : network === 'mainnet';
  if (!real) return null;
  const last = extras.closes?.last ?? lastEndedSession(now);
  const close = extras.closes?.close.get(seed.symbol) ?? null;
  const prevClose = extras.closes?.prevClose.get(seed.symbol) ?? null;
  const lastSession: LastSessionView = { tradingDay: last.tradingDay, end: last.end, close, prevClose, change: pctOf(close, prevClose) };
  const d = extras.dex;
  const pool = dexPoolsOf(network)[seed.symbol];
  const dexOk =
    !!d &&
    !!pool &&
    d.pool === pool.pool &&
    !d.belowThreshold &&
    now - d.checkedAt <= DEX_PARAMS.staleAfterMs &&
    now - d.liquidityAt <= DEX_PARAMS.liquidityStaleAfterMs &&
    d.tradeAt > last.end;
  // The pool compared with itself at the close: a standing gap between the pool and the official quote is no move.
  const closeRef = d && d.close && d.close.end === last.end ? d.close.price : null;
  const dex: DexView | null = dexOk
    ? { price: d.price, change: pctOf(d.price, closeRef), closeRef, closeAt: closeRef ? d.close!.at : null, tradeAt: d.tradeAt, block: d.block, pool: d.pool, liquidityUsdg: d.liquidityUsdg }
    : null;
  return dex ? { change: dex.change, changeBasis: 'dexSinceClose', lastSession, dex } : { change: lastSession.change, changeBasis: 'lastSession', lastSession, dex: null };
}

export function marketView(seed: MarketSeed, snap: MarketSnapshot | undefined, now: number, network: NetworkName, cacheOk = true, extras: MarketExtras = {}): MarketView {
  const priceStr = snap?.price ?? seed.seedPrice;
  const price = parseWad(priceStr) ?? 0n;
  const open = parseWad(snap?.open24h ?? priceStr) ?? price;
  const mark = snap?.mark ?? toDecimalString(wmul(price, WAD + bps(DEMO.markPremiumBps), 'floor'), 2);
  const demo = network !== 'mainnet';
  const change24h = changePct(price, open);
  const closed = closedFields(seed, snap, now, network, extras);
  return {
    symbol: seed.symbol,
    name: seed.name,
    token: seed.token?.address ?? null,
    status: seed.status,
    price: priceStr,
    mark,
    open24h: toDecimalString(open),
    change24h,
    fundingPerHour: demo ? seed.fundingPerHour : null,
    openInterest: demo ? seed.openInterest : null,
    demo,
    maxLeverage: PROTOCOL.maxLeverage,
    takerFeeBps: PROTOCOL.takerFeeBps,
    maintenanceMargin: MM,
    spark: snap?.spark?.length ? snap.spark : [priceStr],
    ...priceState(snap, now, network, cacheOk),
    source: snap?.source ?? null,
    updatedAt: snap?.updatedAt ?? null,
    ...(closed ?? { change: change24h, changeBasis: '24h' as const, lastSession: null, dex: null }),
  };
}
