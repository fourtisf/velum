/** Test helpers for authenticated Redis values (packages/config/src/cache-mac.ts, audit F-2). */
import { candleCachePayload, cacheKeys, type Candle, type MarketSnapshot, type NetworkName, type PriceSource, type Timeframe } from '@velum/config';
import { createCacheMac, type CacheMac } from '@velum/config/src/cache-mac';

/** The DATABASE_URL the tests derive the cache key from (the workers' tests use the same one). */
export const TEST_DATABASE_URL_FOR_MAC = 'postgresql://velum:test-only@127.0.0.1:5432/velum';
export const testMac: CacheMac = createCacheMac(TEST_DATABASE_URL_FOR_MAC, 'testnet');
export const mainnetTestMac: CacheMac = createCacheMac(TEST_DATABASE_URL_FOR_MAC, 'mainnet');

/** [key, value] of a snapshot as the workers store it. */
export const sealedSnapshot = (s: MarketSnapshot, mac: CacheMac = testMac): [string, string] => [cacheKeys.price(s.symbol), mac.seal(cacheKeys.price(s.symbol), JSON.stringify(s))];

/** [key, value] of a candle cache as the workers store it. */
export function sealedCandles(symbol: string, tf: Timeframe, candles: Candle[], source: PriceSource = 'demo', mac: CacheMac = testMac, network: NetworkName = mac.network): [string, string] {
  const key = cacheKeys.candles(symbol, tf);
  return [key, mac.seal(key, candleCachePayload({ network, source, candles }))];
}

/** [key, value] of a heartbeat as the workers store it. */
export const sealedHeartbeat = (worker: string, at: number, mac: CacheMac = testMac): [string, string] => [cacheKeys.heartbeat(worker), mac.seal(cacheKeys.heartbeat(worker), String(at))];
