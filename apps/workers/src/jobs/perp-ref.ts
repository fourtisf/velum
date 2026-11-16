/**
 * Real perps metrics for mainnet while Velum's own perps are not live there: each market's perp on Lighter, the perps
 * venue of Robinhood Chain (packages/config/src/perps-ref.ts says what was checked). Once a minute: one funding-rates
 * read, then one orderBookDetails read per market (about 2 KB each), one at a time; every value is validated by
 * lighterRef and stored authenticated in Redis for 15 minutes (the API serves it only while fresher than 5 minutes).
 * A failed or implausible read leaves that market without a reference (the web shows a dash), never a guess.
 */
import { cacheKeys } from '@velum/config';
import { LIGHTER_API, LIGHTER_MARKETS, lighterRef } from '@velum/config/src/perps-ref';
import type { CacheMac } from '@velum/config/src/cache-mac';
import type { Redis } from 'ioredis';
import type { Logger } from '../lib/log';
import { redactUrls } from '../lib/redact';

export const PERP_REF_EVERY_MS = 60_000;
const TTL_S = 15 * 60;
/** Largest response accepted (the funding list is about 50 KB). */
const MAX_BYTES = 1_000_000;

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
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
  /** Markets to read (default: every market with a Lighter perp). */
  symbols?: readonly string[];
}

/** One round: returns the symbols that got a fresh reference. */
export async function runPerpRef(d: PerpRefDeps): Promise<string[]> {
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
  const pipe = d.redis.pipeline();
  const done: string[] = [];
  for (const symbol of symbols) {
    try {
      const body = (await getJson(fetchImpl, `${LIGHTER_API}/api/v1/orderBookDetails?market_id=${LIGHTER_MARKETS[symbol]}`)) as { order_book_details?: unknown[] } | null;
      const ref = lighterRef(symbol, body?.order_book_details?.[0], rates, now());
      if (!ref) {
        d.log.warn('lighter market reference rejected', { symbol });
        continue;
      }
      const key = cacheKeys.perpRef(symbol);
      pipe.set(key, d.mac.seal(key, JSON.stringify(ref)), 'EX', TTL_S);
      done.push(symbol);
    } catch (err) {
      d.log.warn('lighter market read failed', { symbol, err: redactUrls(err instanceof Error ? err.message : String(err)) });
    }
  }
  if (done.length) await pipe.exec();
  return done;
}
