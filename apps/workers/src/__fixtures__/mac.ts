/** Test helpers for authenticated Redis values (packages/config/src/cache-mac.ts, audit F-2). */
import { createCacheMac, type CacheMac } from '@velum/config/src/cache-mac';

/** The DATABASE_URL the tests derive their cache key from (any value works; api and workers must agree). */
export const TEST_DATABASE_URL_FOR_MAC = 'postgresql://velum:test-only@127.0.0.1:5432/velum';
export const testMac: CacheMac = createCacheMac(TEST_DATABASE_URL_FOR_MAC, 'testnet');
export const mainnetTestMac: CacheMac = createCacheMac(TEST_DATABASE_URL_FOR_MAC, 'mainnet');

/** The JSON payload of an authenticated value, or null when it is missing or does not verify. */
export function openJson<T = unknown>(raw: string | null | undefined, key: string, mac: CacheMac = testMac): T | null {
  const payload = mac.open(key, raw);
  return payload === null ? null : (JSON.parse(payload) as T);
}
