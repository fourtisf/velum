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
  fundingPerHour: string;
  openInterest: string;
  maxLeverage: number;
  takerFeeBps: number;
  maintenanceMargin: string;
  spark: string[];
  stale?: boolean;
  source?: string | null;
}

export interface PoolDTO {
  symbol: string;
  pair: string;
  feeBps: number;
  sizeRounded: string;
  aprEst: string;
  updatedHour: number;
  status?: MarketStatus;
}

export interface StatsDTO {
  markets: number;
  openInterest: string;
  shieldedValue: string;
  proofsToday: number;
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

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${ENV.apiUrl}${path}`, { signal, headers: { accept: 'application/json' }, cache: 'no-store' });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(err?.code ?? 'HTTP_' + res.status, err?.message ?? res.statusText, res.status);
  }
  return body as T;
}

export const api = {
  markets: (signal?: AbortSignal) => get<MarketDTO[]>('/v1/markets', signal),
  candles: (symbol: string, tf: Timeframe, limit = 110, signal?: AbortSignal) =>
    get<Candle[]>(`/v1/markets/${encodeURIComponent(symbol)}/candles?tf=${tf}&limit=${limit}`, signal),
  pools: (signal?: AbortSignal) => get<PoolDTO[]>('/v1/pools', signal),
  stats: (signal?: AbortSignal) => get<StatsDTO>('/v1/stats', signal),
};
