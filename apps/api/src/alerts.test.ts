/**
 * /v1/alerts (Telegram alerts link) and /v1/referrals: the bot link is issued only for a wallet's own fresh signature;
 * referrals are recorded once per wallet, never for its own code, and counted.
 */
import { alertsMessage, refCode } from '@velum/config/src/alerts';
import type { FastifyInstance } from 'fastify';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import type { ApiEnv } from './env';
import type { AppDeps } from './lib/deps';

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
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
  telegramBot: 'velum_alerts_bot',
};
const acct = privateKeyToAccount(`0x${'59'.repeat(32)}`);

let app: FastifyInstance | undefined;
async function make(over: Partial<AppDeps> = {}, envOver: Partial<ApiEnv> = {}) {
  app = await buildApp({
    env: { ...env, ...envOver },
    cache: { ping: async () => true, snapshots: async () => new Map(), candles: async () => null, heartbeat: async () => null },
    db: { ping: async () => true, candles: async () => [], publishedPools: async () => [] },
    chain: { blockNumber: async () => null },
    now: () => NOW,
    ...over,
  });
  return app;
}
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('alerts link', () => {
  it('issues a one-time bot link for the wallet’s own fresh signature', async () => {
    const codes = new Map<string, [string, number]>();
    const a = await make({ alerts: { putCode: async (c, addr, ttl) => void codes.set(c, [addr, ttl]) } });
    expect((await a.inject('/v1/alerts')).json()).toEqual({ enabled: true, bot: 'velum_alerts_bot' });
    const issuedAt = new Date(NOW - 60_000).toISOString();
    const signature = await acct.signMessage({ message: alertsMessage(acct.address, issuedAt) });
    const res = await a.inject({ method: 'POST', url: '/v1/alerts/code', payload: { address: acct.address, issuedAt, signature } });
    expect(res.statusCode).toBe(200);
    const j = res.json() as { code: string; url: string; expiresIn: number };
    expect(j.url).toBe(`https://t.me/velum_alerts_bot?start=${j.code}`);
    expect(j.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(codes.get(j.code)).toEqual([acct.address.toLowerCase(), 900]);
  });

  it('refuses an old signature, another wallet’s, junk, and answers 404 when alerts are off', async () => {
    const a = await make({ alerts: { putCode: async () => undefined } });
    const old = new Date(NOW - 11 * 60_000).toISOString();
    const sigOld = await acct.signMessage({ message: alertsMessage(acct.address, old) });
    expect((await a.inject({ method: 'POST', url: '/v1/alerts/code', payload: { address: acct.address, issuedAt: old, signature: sigOld } })).json()).toMatchObject({ error: { message: 'The signature is too old. Sign again.' } });
    const issuedAt = new Date(NOW).toISOString();
    const sig = await acct.signMessage({ message: alertsMessage(acct.address, issuedAt) });
    const other = '0x1111111111111111111111111111111111111111';
    expect((await a.inject({ method: 'POST', url: '/v1/alerts/code', payload: { address: other, issuedAt, signature: sig } })).json()).toMatchObject({ error: { message: 'The signature is not from this wallet.' } });
    expect((await a.inject({ method: 'POST', url: '/v1/alerts/code', payload: { address: acct.address, issuedAt, signature: '0x12' } })).statusCode).toBe(400);
    await a.close();
    const b = await make({}, { telegramBot: null });
    expect((await b.inject('/v1/alerts')).json()).toEqual({ enabled: false, bot: null });
    expect((await b.inject({ method: 'POST', url: '/v1/alerts/code', payload: { address: acct.address, issuedAt, signature: sig } })).statusCode).toBe(404);
  });
});

describe('referrals', () => {
  it('records a wallet once, never its own code, and counts per code', async () => {
    const seen = new Map<string, string>();
    const counts = new Map<string, number>();
    const a = await make({
      referrals: {
        attribute: async (addr, code) => {
          if (seen.has(addr)) return false;
          seen.set(addr, code);
          counts.set(code, (counts.get(code) ?? 0) + 1);
          return true;
        },
        count: async (code) => counts.get(code) ?? 0,
      },
    });
    const code = 'abcdef0123';
    expect((await a.inject({ method: 'POST', url: '/v1/referrals', payload: { address: acct.address, code } })).json()).toEqual({ attributed: true });
    expect((await a.inject({ method: 'POST', url: '/v1/referrals', payload: { address: acct.address, code: '0000000000' } })).json()).toEqual({ attributed: false });
    expect((await a.inject({ method: 'POST', url: '/v1/referrals', payload: { address: acct.address, code: refCode(acct.address) } })).json()).toEqual({ attributed: false });
    expect((await a.inject(`/v1/referrals/${code}`)).json()).toEqual({ code, friends: 1 });
    expect((await a.inject('/v1/referrals/NOTACODE')).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/v1/referrals', payload: { address: 'x', code } })).statusCode).toBe(400);
  });
});
