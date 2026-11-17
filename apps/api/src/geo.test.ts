/**
 * GET /v1/geo (the perps geoblock) and POST/GET /v1/client-errors (error reports from the web): the country sources,
 * blocked / allowed / unknown, the env rules, scrubbing, the rate limit and the admin token.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadEnv, type ApiEnv } from './env';
import type { AppDeps, ClientErrorRecord } from './lib/deps';
import { createGeo, normalizeCountry } from './lib/geo';

const env: ApiEnv = {
  host: '127.0.0.1',
  port: 0,
  databaseUrl: 'postgresql://x',
  redisUrl: 'redis://x',
  corsOrigins: false,
  rateReadPerMin: 120,
  rateQuotePerMin: 30,
  rateHealthPerMin: 60,
  rpcUrl: 'http://localhost:1',
  chainId: 4663,
  demoMode: true,
  logLevel: 'silent',
  proxySecret: null,
  socketPath: null,
  redis: { db: 0 },
  rateMarketsPerMin: 600,
  network: 'mainnet',
};

let app: FastifyInstance | undefined;
async function make(over: Partial<AppDeps> = {}, envOver: Partial<ApiEnv> = {}) {
  app = await buildApp({
    env: { ...env, ...envOver },
    cache: { ping: async () => true, snapshots: async () => new Map(), candles: async () => null, heartbeat: async () => null },
    db: { ping: async () => true, candles: async () => [], publishedPools: async () => [] },
    chain: { blockNumber: async () => null },
    ...over,
  });
  return app;
}
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /v1/geo', () => {
  it('blocks perps for the configured countries, allows others, and says unknown without a source', async () => {
    const a = await make({ geo: createGeo({ header: 'cf-ipcountry', proxySecret: null }) });
    const us = await a.inject({ url: '/v1/geo', headers: { 'cf-ipcountry': 'us' } });
    expect(us.json()).toEqual({ country: 'US', perps: 'blocked' });
    expect(us.headers['cache-control']).toBe('private, no-store');
    expect((await a.inject({ url: '/v1/geo', headers: { 'cf-ipcountry': 'ID' } })).json()).toEqual({ country: 'ID', perps: 'allowed' });
    expect((await a.inject({ url: '/v1/geo', headers: { 'cf-ipcountry': 'XX' } })).json()).toEqual({ country: null, perps: 'unknown' });
    expect((await a.inject({ url: '/v1/geo', headers: { 'cf-ipcountry': 'T1' } })).json()).toEqual({ country: null, perps: 'unknown' });
    await a.close();
    const b = await make();
    expect((await b.inject({ url: '/v1/geo', headers: { 'cf-ipcountry': 'US' } })).json()).toEqual({ country: null, perps: 'unknown' });
    await b.close();
    const c = await make({ geo: createGeo({ header: 'cf-ipcountry', proxySecret: null }) }, { perpsBlocked: ['ID'] });
    expect((await c.inject({ url: '/v1/geo', headers: { 'cf-ipcountry': 'ID' } })).json()).toEqual({ country: 'ID', perps: 'blocked' });
  });

  it('a missing database file reads as unknown (and says so once)', async () => {
    const msgs: string[] = [];
    const a = await make({ geo: createGeo({ dbPath: '/nonexistent/dbip.mmdb', proxySecret: null, onError: (m) => msgs.push(m) }) });
    expect((await a.inject({ url: '/v1/geo', remoteAddress: '8.8.8.8' })).json()).toEqual({ country: null, perps: 'unknown' });
    expect(msgs[0]).toMatch(/GEOIP_DB unreadable/);
  });

  it('normalizes country codes', () => {
    expect(normalizeCountry(' us ')).toBe('US');
    expect(normalizeCountry('USA')).toBeNull();
    expect(normalizeCountry(['US'])).toBeNull();
  });

  it('env: header name, database path, blocked list and admin token are checked', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/v', REDIS_URL: 'redis://localhost:6379', RPC_URL: 'http://localhost:8545', CHAIN_ID: '46630' };
    const e = loadEnv({ ...base, GEO_COUNTRY_HEADER: 'CF-IPCountry', GEOIP_DB: '/var/lib/velum/dbip-country.mmdb', PERPS_BLOCKED_COUNTRIES: 'us, ir', ADMIN_TOKEN: 'a'.repeat(40) } as NodeJS.ProcessEnv);
    expect([e.geoHeader, e.geoipDb, e.perpsBlocked, e.adminToken]).toEqual(['cf-ipcountry', '/var/lib/velum/dbip-country.mmdb', ['US', 'IR'], 'a'.repeat(40)]);
    expect(loadEnv(base as NodeJS.ProcessEnv).perpsBlocked).toEqual(['US', 'CU', 'IR', 'KP', 'SY']);
    expect(() => loadEnv({ ...base, PERPS_BLOCKED_COUNTRIES: 'USA' } as NodeJS.ProcessEnv)).toThrow(/two-letter country codes/);
    expect(() => loadEnv({ ...base, ADMIN_TOKEN: 'short' } as NodeJS.ProcessEnv)).toThrow(/ADMIN_TOKEN/);
    expect(() => loadEnv({ ...base, GEOIP_DB: '../x.mmdb' } as NodeJS.ProcessEnv)).toThrow(/GEOIP_DB/);
  });
});

describe('client errors', () => {
  const sink = () => {
    const list: ClientErrorRecord[] = [];
    return { list, push: async (r: ClientErrorRecord) => void list.unshift(r), recent: async (n: number) => list.slice(0, n) };
  };

  it('keeps a scrubbed report: no addresses, keys or long hex', async () => {
    const s = sink();
    const a = await make({ clientErrors: s, now: () => 1_800_000_000_000 });
    const res = await a.inject({
      method: 'POST',
      url: '/v1/client-errors',
      payload: { message: 'Failed for 0x92ef4c8d8df09a9ae7ed9a12409bc9a84fb70e7b', stack: 'at f (app.js:1:2)\nsig 0x' + 'ab'.repeat(65), path: '/app/trade/TSLA?ref=0xabc', release: 'v1.2', kind: 'unhandledrejection' },
    });
    expect(res.statusCode).toBe(204);
    expect(s.list[0]).toEqual({ at: 1_800_000_000_000, kind: 'unhandledrejection', message: 'Failed for 0x…', stack: 'at f (app.js:1:2)\nsig 0x…', path: '/app/trade/TSLA', release: 'v1.2' });
  });

  it('refuses junk and extra fields, and limits each client to 10 a minute', async () => {
    const a = await make({ clientErrors: sink() });
    expect((await a.inject({ method: 'POST', url: '/v1/client-errors', payload: {} })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/v1/client-errors', payload: { message: 'x', wallet: '0x1' } })).statusCode).toBe(400);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await a.inject({ method: 'POST', url: '/v1/client-errors', payload: { message: `e${i}` } })).statusCode;
    expect(last).toBe(429);
  });

  it('reading needs the admin token, and is off without one', async () => {
    const s = sink();
    await s.push({ at: 1, kind: 'error', message: 'boom', stack: '', path: '/', release: '' });
    const a = await make({ clientErrors: s }, { adminToken: 't'.repeat(32) });
    expect((await a.inject('/v1/client-errors')).statusCode).toBe(404);
    expect((await a.inject({ url: '/v1/client-errors', headers: { 'x-velum-admin-token': 'wrong' } })).statusCode).toBe(404);
    const ok = await a.inject({ url: '/v1/client-errors', headers: { 'x-velum-admin-token': 't'.repeat(32) } });
    expect(ok.json()).toEqual({ errors: [{ at: 1, kind: 'error', message: 'boom', stack: '', path: '/', release: '' }] });
    await a.close();
    const b = await make({ clientErrors: s });
    expect((await b.inject({ url: '/v1/client-errors', headers: { 'x-velum-admin-token': 't'.repeat(32) } })).statusCode).toBe(404);
  });
});
