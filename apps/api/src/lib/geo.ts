/**
 * The visitor's country, for the perps geoblock (GET /v1/geo). Two sources, either or both:
 *  - a country header set by a trusted edge in front of Nginx (GEO_COUNTRY_HEADER, e.g. "cf-ipcountry" when the site is
 *    behind Cloudflare, which overwrites it on every request; never set it otherwise, since a visitor could send it);
 *  - a country database file (GEOIP_DB): DB-IP's free "IP to Country Lite" in MaxMind's mmdb format (CC BY 4.0,
 *    deploy/geoip-update.sh downloads it monthly), looked up by the client address Nginx reports.
 * Unknown (no source configured, a private address, a lookup miss) is not "blocked": the web then relies on the user's
 * own statement in the perps terms. Pure apart from reading the file; the file is re-read when it changes.
 */
import { readFileSync, statSync } from 'node:fs';
import type { FastifyRequest } from 'fastify';
import { Reader, type CountryResponse } from 'mmdb-lib';
import { clientAddress } from './client-address';

export interface GeoLookup {
  /** ISO 3166-1 alpha-2 country of the request (upper case), or null when unknown. */
  country(req: FastifyRequest): string | null;
}

const CODE = /^[A-Z]{2}$/;
/** Values an edge uses for "unknown" or "Tor" rather than a country. */
const NOT_A_COUNTRY = new Set(['XX', 'T1', 'A1', 'A2', 'O1', 'EU', 'AP']);

export function normalizeCountry(v: unknown): string | null {
  const c = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return CODE.test(c) && !NOT_A_COUNTRY.has(c) ? c : null;
}

/** A database reader that reloads the file when its modification time changes (checked at most every 10 minutes). */
function dbReader(path: string, onError: (msg: string) => void): (ip: string) => string | null {
  let reader: Reader<CountryResponse> | null = null;
  let mtime = 0;
  let checked = 0;
  const load = () => {
    const now = Date.now();
    if (reader && now - checked < 600_000) return;
    checked = now;
    try {
      const m = statSync(path).mtimeMs;
      if (reader && m === mtime) return;
      reader = new Reader<CountryResponse>(readFileSync(path));
      mtime = m;
    } catch (e) {
      if (!reader) onError(`GEOIP_DB unreadable: ${(e as Error).message.slice(0, 120)}`);
    }
  };
  return (ip) => {
    load();
    if (!reader) return null;
    try {
      return normalizeCountry(reader.get(ip)?.country?.iso_code);
    } catch {
      return null;
    }
  };
}

export function createGeo(opts: { header?: string | null; dbPath?: string | null; proxySecret: string | null; onError?: (msg: string) => void }): GeoLookup {
  const header = opts.header ? opts.header.toLowerCase() : null;
  const db = opts.dbPath ? dbReader(opts.dbPath, opts.onError ?? (() => undefined)) : null;
  return {
    country(req) {
      if (header) {
        const c = normalizeCountry(req.headers[header]);
        if (c) return c;
      }
      if (db) {
        const ip = clientAddress(req, opts.proxySecret);
        if (ip) return db(ip);
      }
      return null;
    },
  };
}

/** Countries where Velum does not offer perps by default: the United States and comprehensively sanctioned countries. */
export const DEFAULT_PERPS_BLOCKED = ['US', 'CU', 'IR', 'KP', 'SY'];
