import { DEMO, PROTOCOL, QUOTE_FROZEN_AFTER_MS, usEquitySession, type MarketSeed, type MarketSnapshot, type NetworkName } from '@velum/config';
import { WAD, bps, maintenanceMargin, parseWad, toDecimalString, wdiv, wmul, type Wad } from '@velum/math';

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
}

const MM = toDecimalString(maintenanceMargin(PROTOCOL), 2);

/** 24h change in percent with 2 decimals. */
export function changePct(price: Wad, open: Wad): string {
  if (open <= 0n) return '0.00';
  return toDecimalString(wdiv((price - open) * 100n, open), 2);
}

export function marketView(seed: MarketSeed, snap: MarketSnapshot | undefined, now: number, network: NetworkName, cacheOk = true): MarketView {
  const priceStr = snap?.price ?? seed.seedPrice;
  const price = parseWad(priceStr) ?? 0n;
  const open = parseWad(snap?.open24h ?? priceStr) ?? price;
  const mark = snap?.mark ?? toDecimalString(wmul(price, WAD + bps(DEMO.markPremiumBps), 'floor'), 2);
  const demo = network !== 'mainnet';
  return {
    symbol: seed.symbol,
    name: seed.name,
    token: seed.token?.address ?? null,
    status: seed.status,
    price: priceStr,
    mark,
    open24h: toDecimalString(open),
    change24h: changePct(price, open),
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
  };
}
