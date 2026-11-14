import { DEMO, PROTOCOL, type MarketSeed, type MarketSnapshot } from '@velum/config';
import { WAD, bps, maintenanceMargin, parseWad, toDecimalString, wdiv, wmul, type Wad } from '@velum/math';

export const MAX_PRICE_AGE_MS = PROTOCOL.oracleMaxAgeSeconds * 1000;

export interface MarketView {
  symbol: string;
  name: string;
  token: string | null;
  status: MarketSeed['status'];
  price: string;
  mark: string;
  open24h: string;
  change24h: string;
  fundingPerHour: string;
  openInterest: string;
  maxLeverage: number;
  takerFeeBps: number;
  maintenanceMargin: string;
  spark: string[];
  /** True when no fresh price exists (missing snapshot or older than the oracle max age). */
  stale: boolean;
  /** Where the price came from: "demo" (simulated) or "chainlink". null before the first tick. */
  source: string | null;
  updatedAt: number | null;
}

const MM = toDecimalString(maintenanceMargin(PROTOCOL), 2);

export function isFresh(snap: MarketSnapshot | undefined, now: number): snap is MarketSnapshot {
  return !!snap && now - snap.updatedAt <= MAX_PRICE_AGE_MS;
}

/** 24h change in percent with 2 decimals. */
export function changePct(price: Wad, open: Wad): string {
  if (open <= 0n) return '0.00';
  return toDecimalString(wdiv((price - open) * 100n, open), 2);
}

export function marketView(seed: MarketSeed, snap: MarketSnapshot | undefined, now: number): MarketView {
  const priceStr = snap?.price ?? seed.seedPrice;
  const price = parseWad(priceStr) ?? 0n;
  const open = parseWad(snap?.open24h ?? priceStr) ?? price;
  const mark = snap?.mark ?? toDecimalString(wmul(price, WAD + bps(DEMO.markPremiumBps), 'floor'), 2);
  return {
    symbol: seed.symbol,
    name: seed.name,
    token: seed.token?.address ?? null,
    status: seed.status,
    price: priceStr,
    mark,
    open24h: toDecimalString(open),
    change24h: changePct(price, open),
    fundingPerHour: seed.fundingPerHour,
    openInterest: seed.openInterest,
    maxLeverage: PROTOCOL.maxLeverage,
    takerFeeBps: PROTOCOL.takerFeeBps,
    maintenanceMargin: MM,
    spark: snap?.spark?.length ? snap.spark : [priceStr],
    stale: !isFresh(snap, now),
    source: snap?.source ?? null,
    updatedAt: snap?.updatedAt ?? null,
  };
}
