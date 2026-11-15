/** Regression tests for audit R2-I4: only Nginx (holding PROXY_SECRET) may name a client address. */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import type { ApiEnv } from '../env';
import { loadEnv } from '../env';
import { PROXY_SECRET_HEADER } from './client-address';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const SECRET = 'a'.repeat(64);
const env: ApiEnv = {
  host: '127.0.0.1',
  port: 0,
  databaseUrl: 'postgresql://x',
  redisUrl: 'redis://x',
  corsOrigins: false,
  rateReadPerMin: 1,
  rateQuotePerMin: 30,
  rateHealthPerMin: 60,
  rpcUrl: 'http://localhost:1',
  chainId: 46630,
  demoMode: true,
  logLevel: 'silent',
  proxySecret: SECRET,
  socketPath: null,
  redis: { db: 0 },
  rateMarketsPerMin: 600,
  network: 'testnet',
};

let app: FastifyInstance | undefined;
async function make(over: Partial<ApiEnv> = {}) {
  app = await buildApp({
    env: { ...env, ...over },
    cache: { ping: async () => true, snapshots: async () => new Map(), candles: async () => null, heartbeat: async () => NOW },
    db: { ping: async () => true, candles: async () => [], publishedPools: async () => [] },
    chain: { blockNumber: async () => 1n },
    now: () => NOW,
  });
  return app;
}
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const get = (a: FastifyInstance, headers: Record<string, string>, remoteAddress = '127.0.0.1') => a.inject({ url: '/v1/stats', headers, remoteAddress }).then((r) => r.statusCode);

describe('R2-I4: X-Forwarded-For / X-Real-IP are trusted only with the proxy secret', () => {
  it('a local program cannot pick a fresh address per request to dodge the limit', async () => {
    const a = await make();
    expect(await get(a, { 'x-forwarded-for': '10.0.0.1', 'x-real-ip': '10.0.0.1' })).toBe(200);
    expect(await get(a, { 'x-forwarded-for': '10.0.0.2', 'x-real-ip': '10.0.0.2' })).toBe(429);
    expect(await get(a, { [PROXY_SECRET_HEADER]: 'b'.repeat(64), 'x-real-ip': '10.0.0.3' })).toBe(429);
  });
  it('cannot spend a real client budget either', async () => {
    const a = await make();
    expect(await get(a, { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7' })).toBe(200);
    // The real client, through Nginx, still has its own budget.
    expect(await get(a, { [PROXY_SECRET_HEADER]: SECRET, 'x-real-ip': '203.0.113.7' })).toBe(200);
    expect(await get(a, { [PROXY_SECRET_HEADER]: SECRET, 'x-real-ip': '203.0.113.7' })).toBe(429);
  });
  it('requests through Nginx are keyed by X-Real-IP, per client, for route limits too', async () => {
    const a = await make({ rateHealthPerMin: 1 });
    const h = (ip: string) => a.inject({ url: '/v1/health', headers: { [PROXY_SECRET_HEADER]: SECRET, 'x-real-ip': ip } }).then((r) => r.statusCode);
    expect(await h('198.51.100.1')).toBe(200);
    expect(await h('198.51.100.1')).toBe(429);
    expect(await h('198.51.100.2')).toBe(200);
    expect(await get(a, { [PROXY_SECRET_HEADER]: SECRET, 'x-real-ip': '198.51.100.3' })).toBe(200);
  });
  it('without a secret, keeps trusting X-Forwarded-For from loopback (older .env files)', async () => {
    const a = await make({ proxySecret: null });
    expect(await get(a, { 'x-forwarded-for': '10.0.0.1' })).toBe(200);
    expect(await get(a, { 'x-forwarded-for': '10.0.0.2' })).toBe(200);
    expect(await get(a, { 'x-forwarded-for': '10.0.0.2' })).toBe(429);
    // Not from loopback: the header is ignored.
    expect(await get(a, { 'x-forwarded-for': '10.0.0.9' }, '192.0.2.1')).toBe(200);
    expect(await get(a, { 'x-forwarded-for': '10.0.0.8' }, '192.0.2.1')).toBe(429);
  });
  it('PROXY_SECRET must be hex', () => {
    const base = { DATABASE_URL: 'postgresql://a', REDIS_URL: 'redis://b' };
    expect(loadEnv(base).proxySecret).toBeNull();
    expect(loadEnv({ ...base, PROXY_SECRET: SECRET }).proxySecret).toBe(SECRET);
    expect(() => loadEnv({ ...base, PROXY_SECRET: 'short' })).toThrow(/PROXY_SECRET/);
  });
});
