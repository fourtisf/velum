/**
 * Authenticated Redis values (audit F-2). Node only: import it as '@velum/config/src/cache-mac' from
 * apps/api and apps/workers. It is not re-exported from index.ts, so the web bundle never pulls in
 * node:crypto.
 *
 * Velum's Redis may be shared: on the default setup every program that knows the server's Redis password
 * can write Velum's keys. Validation alone (cache.ts) cannot tell a forged but well-formed price from a
 * real one, so every value the API trusts (price snapshots, candle caches, heartbeats) carries an
 * HMAC-SHA256 under a key only the API and the workers can derive: both receive DATABASE_URL
 * (deploy/ecosystem.config.cjs), which a Redis co-tenant does not have. The key is HKDF-SHA256 of
 * DATABASE_URL with a Velum-specific label, so it is never the database password itself and is useless
 * for anything else. Rotating the database password (a new DATABASE_URL) rotates the key: values written
 * with the old key then read as missing until the workers rewrite them, within one price tick.
 *
 * A value is `vmac1.<base64url HMAC>.<payload>`; the MAC covers the network (testnet or mainnet), the
 * Redis key and the payload, so a value is valid only under the key and on the network it was written
 * for. A value with a bad or missing MAC is treated as absent. A co-tenant can still delete values or
 * put back an older genuine value under the same key (replay); every value carries its own times, so an
 * old value reads as stale, never as a live price that was not quoted.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { NetworkName } from './index';

/** Prefix of every authenticated value (format version 1). */
export const CACHE_MAC_PREFIX = 'vmac1.';
/** HKDF info: domain separation, so the derived key serves this purpose only. */
export const CACHE_MAC_LABEL = 'velum/redis-cache-mac/v1';
const SALT = 'velum';
/** base64url of a 32-byte HMAC-SHA256, unpadded. */
const MAC_CHARS = 43;
/** Values longer than this are never hashed (the largest, 300 cached candles, is about 30 KB). */
export const MAX_SEALED_BYTES = 256 * 1024;

export interface CacheMac {
  readonly network: NetworkName;
  /** The Redis value that stores `payload` under `key`, authenticated. */
  seal(key: string, payload: string): string;
  /**
   * The payload of an authenticated value read from `key`, or null when the value is missing, not a
   * string, longer than `maxBytes`, unauthenticated, or its MAC does not match (another key, another
   * network, another DATABASE_URL, or tampered with).
   */
  open(key: string, raw: unknown, maxBytes?: number): string | null;
}

/** The 32-byte MAC key for a DATABASE_URL (HKDF-SHA256, Velum-specific salt and label). */
export function deriveCacheMacKey(databaseUrl: string): Buffer {
  const ikm = (databaseUrl ?? '').trim();
  if (!ikm) throw new Error('DATABASE_URL is required to authenticate cached values.');
  return Buffer.from(hkdfSync('sha256', ikm, SALT, CACHE_MAC_LABEL, 32));
}

export function createCacheMac(databaseUrl: string, network: NetworkName): CacheMac {
  const key = deriveCacheMacKey(databaseUrl);
  // NUL never occurs in a network name or a Redis key, so the framing is unambiguous.
  const mac = (k: string, payload: string): Buffer => createHmac('sha256', key).update(network).update('\0').update(k).update('\0').update(payload).digest();
  return {
    network,
    seal(k, payload) {
      return `${CACHE_MAC_PREFIX}${mac(k, payload).toString('base64url')}.${payload}`;
    },
    open(k, raw, maxBytes = MAX_SEALED_BYTES) {
      if (typeof raw !== 'string' || raw.length > maxBytes + CACHE_MAC_PREFIX.length + MAC_CHARS + 1) return null;
      if (!raw.startsWith(CACHE_MAC_PREFIX) || raw.charCodeAt(CACHE_MAC_PREFIX.length + MAC_CHARS) !== 46 /* . */) return null;
      const given = Buffer.from(raw.slice(CACHE_MAC_PREFIX.length, CACHE_MAC_PREFIX.length + MAC_CHARS), 'base64url');
      if (given.length !== 32) return null;
      const payload = raw.slice(CACHE_MAC_PREFIX.length + MAC_CHARS + 1);
      return timingSafeEqual(given, mac(k, payload)) ? payload : null;
    },
  };
}
