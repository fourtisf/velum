import { DEMO, PROTOCOL, QUOTE_FROZEN_AFTER_MS, isAlwaysOpenSource, usEquitySession, type MarketSeed, type MarketSnapshot, type NetworkName } from '@velum/config';
import { PERP_REF_MAX_AGE_MS, type PerpRef } from '@velum/config/src/perps-ref';
import { WAD, bps, maintenanceMargin, parseWad, toDecimalString, wdiv, wmul, type Wad } from '@velum/math';

export const MAX_PRICE_AGE_MS = PROTOCOL.oracleMaxAgeSeconds * 1000;

/**
 * Why a price is not live (audit M-1):
 *  - noPrice      no snapshot (the workers have not priced the market yet)
 *  - unavailable  the cache could not be read (Redis down); the last known price is shown, not live
 *  - outdated     the workers have not confirmed the quote with the source for over MAX_PRICE_AGE_MS
 *  - demoSource   a simulated price on mainnet (never live there)
 *  - marketClosed the US-equity session for Stock Tokens is closed (weekend or US market holiday); never for Uniswap
 *                 prices, which trade 24/7 onchain
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
  /**
   * Whether the market of this price trades now: for the stock quote sources (Robinhood, Chainlink) the 24/5
   * US-equity session (weekends and US holidays closed); for Uniswap always (it trades 24/7 onchain).
   */
  marketOpen: boolean;
  /** Seconds since the quote last changed (the snapshot's quote time), null without a snapshot. */
  quoteAge: number | null;
}

export function priceState(snap: MarketSnapshot | undefined, now: number, network: NetworkName, cacheOk = true): PriceState {
  // A Uniswap price trades 24/7: its market is always open (the session calendar is for the stock quote sources).
  const marketOpen = isAlwaysOpenSource(snap?.source) || usEquitySession(now).open;
  const quoteAge = snap ? Math.max(0, Math.floor((now - snap.updatedAt) / 1000)) : null;
  const stale = (staleReason: StaleReason | null): PriceState => ({ stale: staleReason !== null, staleReason, marketOpen, quoteAge });
  if (!cacheOk) return stale('unavailable');
  if (!snap) return stale('noPrice');
  if (snap.source === 'demo' && network === 'mainnet') return stale('demoSource');
  if (now - (snap.checkedAt ?? snap.updatedAt) > MAX_PRICE_AGE_MS) return stale('outdated');
  if (snap.source === 'demo') return stale(null);
  // Uniswap trades 24/7 onchain: the US session calendar and the frozen-quote rule do not apply to it. Its price is
  // live while the workers keep reading the pools (checkedAt above).
  if (isAlwaysOpenSource(snap.source)) return stale(null);
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
  /**
   * Funding per hour in percent, signed (positive: longs pay). Demo value on testnet. On mainnet the market's perp on
   * Lighter while that reference is fresh (`perpsRef`), else null: Velum's own perps are not live there yet.
   */
  fundingPerHour: string | null;
  /** Open interest in USD (one side). Demo on testnet; on mainnet Lighter's (`perpsRef`) or null. */
  openInterest: string | null;
  /** True when fundingPerHour and openInterest are simulated (testnet); the price's origin is `source`. */
  demo: boolean;
  /**
   * Where mark, fundingPerHour and openInterest come from on mainnet: the market's perp on Lighter (the perps venue of
   * Robinhood Chain), read at `at`, with its index price. null when there is none (no Lighter market, a stale read, or
   * testnet). A reference, not Velum's own market: clients label it with the venue.
   */
  perpsRef: { venue: string; market: number; index: string; at: number } | null;
  maxLeverage: number;
  takerFeeBps: number;
  maintenanceMargin: string;
  spark: string[];
  /** Where the price came from: "demo" (simulated), "robinhood", "chainlink" or "uniswap". null before the first tick. */
  source: string | null;
  /** Quote time of the price (when it last changed), null before the first tick. */
  updatedAt: number | null;
}

const MM = toDecimalString(maintenanceMargin(PROTOCOL), 2);

/** 24h change in percent with 2 decimals. */
export function changePct(price: Wad, open: Wad): string {
  if (open <= 0n) return '0.00';
  return toDecimalString(wdiv((price - open) * 100n, open), 2);
}

export function marketView(seed: MarketSeed, snap: MarketSnapshot | undefined, now: number, network: NetworkName, cacheOk = true, perp?: PerpRef): MarketView {
  const priceStr = snap?.price ?? seed.seedPrice;
  const price = parseWad(priceStr) ?? 0n;
  const open = parseWad(snap?.open24h ?? priceStr) ?? price;
  const demo = network !== 'mainnet';
  // Mainnet: the Lighter perp's numbers while fresh (never on testnet, never older than PERP_REF_MAX_AGE_MS).
  const ref = !demo && perp && perp.symbol === seed.symbol && now - perp.at <= PERP_REF_MAX_AGE_MS && perp.at <= now + 30_000 ? perp : null;
  // The demo mark premium is a testnet simulation: on mainnet without a perp reference the mark is the price itself.
  const mark = ref?.mark ?? (demo ? (snap?.mark ?? toDecimalString(wmul(price, WAD + bps(DEMO.markPremiumBps), 'floor'), 2)) : priceStr);
  return {
    symbol: seed.symbol,
    name: seed.name,
    token: seed.token?.address ?? null,
    status: seed.status,
    price: priceStr,
    mark,
    open24h: toDecimalString(open),
    change24h: changePct(price, open),
    fundingPerHour: demo ? seed.fundingPerHour : (ref?.fundingPerHour ?? null),
    openInterest: demo ? seed.openInterest : (ref?.openInterest ?? null),
    demo,
    perpsRef: ref ? { venue: ref.venue, market: ref.market, index: ref.index, at: ref.at } : null,
    maxLeverage: PROTOCOL.maxLeverage,
    takerFeeBps: PROTOCOL.takerFeeBps,
    maintenanceMargin: MM,
    spark: snap?.spark?.length ? snap.spark : [priceStr],
    ...priceState(snap, now, network, cacheOk),
    source: snap?.source ?? null,
    updatedAt: snap?.updatedAt ?? null,
  };
}
