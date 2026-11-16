/**
 * Real perps metrics for mainnet (packages/config/src/perps-ref.ts and hyperliquid.ts say what was checked), stored
 * authenticated in Redis for 15 minutes (the API serves them only while fresher than 5 minutes), once a minute:
 *  - hyperliquid (default): one metaAndAssetCtxs read of the xyz dex covers every market (where Velum routes real
 *    perps orders, so the terminal shows the venue it trades on);
 *  - lighter: one funding-rates read, then one orderBookDetails read per market, one at a time.
 * Every value is validated (hyperliquidRef / lighterRef). A failed or implausible read leaves that market without a
 * reference (the web shows a dash), never a guess.
 */
import { cacheKeys } from '@velum/config';
import { HL_API, HL_DEX, HL_MARKETS } from '@velum/config/src/hyperliquid';
import { LIGHTER_API, LIGHTER_MARKETS, hyperliquidRef, lighterRef, type PerpRef } from '@velum/config/src/perps-ref';
import type { CacheMac } from '@velum/config/src/cache-mac';
import type { Redis } from 'ioredis';
import type { Logger } from '../lib/log';
import { redactUrls } from '../lib/redact';

export const PERP_REF_EVERY_MS = 60_000;
const TTL_S = 15 * 60;
/** Largest response accepted (the funding list is about 50 KB). */
const MAX_BYTES = 1_000_000;

async function getJson(fetchImpl: typeof fetch, url: string, body?: unknown): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('response too large');
  return JSON.parse(text);
}

export interface PerpRefDeps {
  redis: Pick<Redis, 'pipeline'>;
  mac: CacheMac;
  log: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Markets to read (default: every market the venue lists). */
  symbols?: readonly string[];
  /** The venue (default: hyperliquid). */
  venue?: 'hyperliquid' | 'lighter';
}

/** Stores validated references; returns their symbols. */
async function store(d: PerpRefDeps, refs: PerpRef[]): Promise<string[]> {
  if (!refs.length) return [];
  const pipe = d.redis.pipeline();
  for (const ref of refs) {
    const key = cacheKeys.perpRef(ref.symbol);
    pipe.set(key, d.mac.seal(key, JSON.stringify(ref)), 'EX', TTL_S);
  }
  await pipe.exec();
  return refs.map((r) => r.symbol);
}

/** One round: returns the symbols that got a fresh reference. */
export async function runPerpRef(d: PerpRefDeps): Promise<string[]> {
  return (d.venue ?? 'hyperliquid') === 'hyperliquid' ? runHyperliquidRef(d) : runLighterRef(d);
}

/** Hyperliquid's xyz dex: one metaAndAssetCtxs read for every market. */
export async function runHyperliquidRef(d: PerpRefDeps): Promise<string[]> {
  const fetchImpl = d.fetchImpl ?? fetch;
  const now = d.now ?? Date.now;
  const symbols = (d.symbols ?? Object.keys(HL_MARKETS)).filter((s) => HL_MARKETS[s] !== undefined);
  let body: unknown;
  try {
    body = await getJson(fetchImpl, `${HL_API}/info`, { type: 'metaAndAssetCtxs', dex: HL_DEX });
  } catch (err) {
    d.log.warn('hyperliquid market read failed', { err: redactUrls(err instanceof Error ? err.message : String(err)) });
    return [];
  }
  const at = now();
  const refs: PerpRef[] = [];
  for (const symbol of symbols) {
    const ref = hyperliquidRef(symbol, body, at);
    if (ref) refs.push(ref);
    else d.log.warn('hyperliquid market reference rejected', { symbol });
  }
  return store(d, refs);
}

/** Lighter: one funding-rates read, then one orderBookDetails read per market. */
export async function runLighterRef(d: PerpRefDeps): Promise<string[]> {
  const fetchImpl = d.fetchImpl ?? fetch;
  const now = d.now ?? Date.now;
  const symbols = (d.symbols ?? Object.keys(LIGHTER_MARKETS)).filter((s) => LIGHTER_MARKETS[s] !== undefined);
  let rates: unknown;
  try {
    rates = ((await getJson(fetchImpl, `${LIGHTER_API}/api/v1/funding-rates`)) as { funding_rates?: unknown } | null)?.funding_rates;
  } catch (err) {
    d.log.warn('lighter funding rates read failed', { err: redactUrls(err instanceof Error ? err.message : String(err)) });
    return [];
  }
  const refs: PerpRef[] = [];
  for (const symbol of symbols) {
    try {
      const body = (await getJson(fetchImpl, `${LIGHTER_API}/api/v1/orderBookDetails?market_id=${LIGHTER_MARKETS[symbol]}`)) as { order_book_details?: unknown[] } | null;
      const ref = lighterRef(symbol, body?.order_book_details?.[0], rates, now());
      if (ref) refs.push(ref);
      else d.log.warn('lighter market reference rejected', { symbol });
    } catch (err) {
      d.log.warn('lighter market read failed', { symbol, err: redactUrls(err instanceof Error ? err.message : String(err)) });
    }
  }
  return store(d, refs);
}
