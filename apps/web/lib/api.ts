import type { Candle, MarketStatus, Timeframe } from '@velum/config';
import { ENV } from './env';

export interface MarketDTO {
  symbol: string;
  name: string;
  token: string | null;
  status: MarketStatus;
  price: string;
  mark: string;
  open24h: string;
  change24h: string;
  /** null on mainnet (no protocol data there yet): shown as a dash. */
  fundingPerHour: string | null;
  openInterest: string | null;
  maxLeverage: number;
  takerFeeBps: number;
  maintenanceMargin: string;
  spark: string[];
  /** A missing `stale` is read as stale (audit web F2). Also true for closed or frozen markets. */
  stale?: boolean;
  /** Why the price is stale, when the API says (closed markets keep their last price, untradable). */
  staleReason?: StaleReason | string;
  /** Whether the stock market is open now. */
  marketOpen?: boolean;
  /** Age of the quote in ms. */
  quoteAge?: number;
  source?: string | null;
  /** When the quote was taken (not when it was polled): ms since epoch (or an ISO string). Hours old while a market is closed. */
  updatedAt?: number | string;
  /** The API marks protocol metrics (OI, funding) that are demo data. */
  demo?: boolean;
}

export interface PoolDTO {
  symbol: string;
  pair: string;
  feeBps: number;
  sizeRounded: string;
  aprEst: string;
  updatedHour: number;
  status?: MarketStatus;
  demo?: boolean;
}

export type StaleReason = 'noPrice' | 'unavailable' | 'outdated' | 'demoSource' | 'marketClosed' | 'quoteFrozen';

export interface StatsDTO {
  markets: number;
  /** The three numbers are null on mainnet (no protocol data yet). */
  openInterest: string | null;
  shieldedValue: string | null;
  proofsToday: number | null;
  demo?: boolean;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function getAt<T>(path: string, signal?: AbortSignal): Promise<{ body: T; serverNow: number | null }> {
  const res = await fetch(`${ENV.apiUrl}${path}`, { signal, headers: { accept: 'application/json' }, cache: 'no-store' });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(err?.code ?? 'HTTP_' + res.status, err?.message ?? res.statusText, res.status);
  }
  // The server's clock (Date header), so a price's age does not depend on this device's clock.
  const date = Date.parse(res.headers.get('date') ?? '');
  return { body: body as T, serverNow: Number.isFinite(date) ? date : null };
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return (await getAt<T>(path, signal)).body;
}

export const api = {
  markets: (signal?: AbortSignal) => get<MarketDTO[]>('/v1/markets', signal),
  /** Markets plus the server's time when it answered (for the price age check, audit web F2). */
  marketsAt: async (signal?: AbortSignal) => {
    const r = await getAt<MarketDTO[]>('/v1/markets', signal);
    return { list: r.body, serverNow: r.serverNow };
  },
  candles: (symbol: string, tf: Timeframe, limit = 110, signal?: AbortSignal) =>
    get<Candle[]>(`/v1/markets/${encodeURIComponent(symbol)}/candles?tf=${tf}&limit=${limit}`, signal),
  pools: (signal?: AbortSignal) => get<PoolDTO[]>('/v1/pools', signal),
  stats: (signal?: AbortSignal) => get<StatsDTO>('/v1/stats', signal),
};
