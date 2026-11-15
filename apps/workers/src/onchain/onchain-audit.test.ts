/**
 * On-chain workers audit (2026-11): M-3 (Redis), I-2 (invalid settings), the RPC_URL_SEND setting, without a chain.
 * The anvil end to end (e2e.test.ts) covers the same with the real workers.
 */
import { parseRedisUrl } from '@velum/config';
import { createCacheMac } from '@velum/config/src/cache-mac';
import { ONCHAIN_STATUS_KEY, parseDeployment, parseOnchainStatus } from '@velum/config/src/onchain';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../lib/log';
import { redact } from '../lib/redact';
import { loadOnchainEnv, loadOnchainSettings } from './env';
import { REDIS_SOCKET_REQUIRED, disabledStatus, redisRefusal, startDisabledStatus, startOnchain } from './index';
import { lockKey, roleLock } from './lock';

const K1 = `0x${'0'.repeat(63)}1`;
const mac = createCacheMac('postgresql://velum@127.0.0.1:1/postgres', 'testnet');
const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

function capture() {
  const lines: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const log: Logger = {
    debug: (msg, data) => void lines.push({ level: 'debug', msg, data }),
    info: (msg, data) => void lines.push({ level: 'info', msg, data }),
    warn: (msg, data) => void lines.push({ level: 'warn', msg, data }),
    error: (msg, data) => void lines.push({ level: 'error', msg, data }),
  };
  return { lines, log };
}

describe('M-3: the on-chain workers run only on a unix-socket Redis', () => {
  it('refuses a TCP Redis connection, accepts a socket', () => {
    expect(redisRefusal({ options: { path: '/run/velum-redis/redis.sock' } })).toBeNull();
    expect(redisRefusal({ options: { path: undefined } })).toBe(REDIS_SOCKET_REQUIRED);
    expect(redisRefusal({ options: {} })).toMatch(/not a unix socket.*deploy\/redis-velum\.sh/);
  });

  it('startOnchain stays off on a TCP Redis and says why (no connection is ever made)', async () => {
    const r = parseDeployment({ chainId: 31337, startBlock: 0, contracts: { vault: A(1), oracle: A(2), spotPools: A(3), makerBook: A(4), perpsMarkets: A(5) }, tokens: { USDG: A(10) } }, 31337);
    if (!r.ok) throw new Error(r.error);
    const { lines, log } = capture();
    const redis = new Redis({ host: '127.0.0.1', port: 1, lazyConnect: true });
    try {
      const h = await startOnchain({ env: loadOnchainEnv({ ONCHAIN_WORKERS: 'true', PRICE_RELAY_PRIVATE_KEY: K1 }), chainId: 31337, rpcUrl: 'http://127.0.0.1:1', prisma: {} as never, redis, mac, log, deployment: r.deployment });
      expect(h).toBeNull();
      expect(lines).toEqual([{ level: 'error', msg: 'on-chain workers off', data: { reason: REDIS_SOCKET_REQUIRED } }]);
      expect(redis.status).toBe('wait'); // never connected
    } finally {
      redis.disconnect();
    }
  });

  it('the role lock reports whether this process holds it (read only)', async () => {
    const store = new Map<string, string>();
    const redis = {
      set: async (k: string, v: string) => (store.has(k) ? null : (store.set(k, v), 'OK' as const)),
      eval: async () => 0,
      get: async (k: string) => store.get(k) ?? null,
    };
    const a = roleLock(redis as never, 'relayer:1');
    expect(await a.owned()).toBe(false);
    expect(await a.hold()).toBe(true);
    expect(await a.owned()).toBe(true);
    store.set(lockKey('relayer:1'), 'co-tenant'); // someone else took it over
    expect(await a.owned()).toBe(false);
  });

  it.skipIf(!process.env.TEST_REDIS_URL)('the disabled status reaches Redis, authenticated, with the reason and no secret', async () => {
    const parsed = parseRedisUrl(process.env.TEST_REDIS_URL!);
    if (!parsed.ok) throw new Error(parsed.error);
    const redis = new Redis({ ...parsed.options, maxRetriesPerRequest: 1 });
    try {
      const stop = startDisabledStatus({ redis, mac, chainId: 31337, reason: REDIS_SOCKET_REQUIRED, log: capture().log });
      await new Promise((r) => setTimeout(r, 200));
      stop();
      const raw = mac.open(ONCHAIN_STATUS_KEY, await redis.get(ONCHAIN_STATUS_KEY), 16 * 1024);
      const s = parseOnchainStatus(raw, Date.now())!;
      expect(s).toMatchObject({ chainId: 31337, deployment: '', error: REDIS_SOCKET_REQUIRED, relayer: { enabled: false }, keeper: { enabled: false }, indexer: { enabled: false } });
      expect(await redis.ttl(ONCHAIN_STATUS_KEY)).toBeGreaterThan(60);
      await redis.del(ONCHAIN_STATUS_KEY);
    } finally {
      await redis.quit();
    }
  });
});

describe('I-2: an invalid on-chain setting disables only the on-chain workers', () => {
  it('never throws; reports the problem by variable name, never the value', () => {
    const bad = `0x${'g'.repeat(64)}`;
    const s = loadOnchainSettings({ ONCHAIN_WORKERS: 'true', PRICE_RELAY_PRIVATE_KEY: bad, CONFIRMATIONS: '-1', RPC_URL_SEND: 'ftp://x' });
    expect(s.env).toBeNull();
    expect(s.error).toMatch(/PRICE_RELAY_PRIVATE_KEY is not a private key/);
    expect(s.error).toMatch(/CONFIRMATIONS must be an integer/);
    expect(s.error).toMatch(/RPC_URL_SEND must be an http\(s\) URL/);
    expect(s.disabled).toMatch(/^Invalid on-chain workers environment: PRICE_RELAY_PRIVATE_KEY is not a private key/);
    expect(`${s.error} ${s.disabled}`).not.toContain('g'.repeat(64));
    // Asked for with an invalid flag value: disabled with the reason.
    expect(loadOnchainSettings({ ONCHAIN_WORKERS: 'yes' }).disabled).toMatch(/ONCHAIN_WORKERS must be true or false/);
    // Not asked for: logged only, nothing for /v1/health.
    expect(loadOnchainSettings({ ONCHAIN_WORKERS: 'false', KEEPER_PRIVATE_KEY: bad })).toMatchObject({ env: null, disabled: null, error: expect.stringMatching(/KEEPER_PRIVATE_KEY/) });
    expect(loadOnchainSettings({ ONCHAIN_WORKERS: 'true' })).toMatchObject({ env: { requested: true }, error: null, disabled: null });
  });

  it('the disabled status parses and names the reason', () => {
    const s = parseOnchainStatus(JSON.stringify(disabledStatus(46630, 'Invalid on-chain workers environment: CONFIRMATIONS must be an integer', 1000, 2000)), 2000);
    expect(s).toMatchObject({ v: 1, chainId: 46630, deployment: '', error: expect.stringMatching(/CONFIRMATIONS/), roles: { relayer: { enabled: false } } });
  });

  it('the status fields the audit added are checked when present and optional otherwise', () => {
    const base = disabledStatus(46630, 'x', 1000, 2000);
    const parse = (o: Record<string, unknown>) => parseOnchainStatus(JSON.stringify({ ...base, ...o }), 2000);
    expect(parse({ roles: undefined, startedAt: undefined, error: undefined, pushIntervalMs: undefined })).not.toBeNull(); // an older release's status
    expect(parse({ roles: { ...base.roles, keeper: { enabled: true, lockHeld: 'yes', lastOkAt: null, everyMs: 1 } } })).toBeNull();
    expect(parse({ pushIntervalMs: '9000' })).toBeNull();
    expect(parse({ relayer: { ...base.relayer, alerts: Array(17).fill('a') } })).toBeNull();
    expect(parse({ relayer: { ...base.relayer, alerts: ['x'.repeat(301)] } })).toBeNull();
    expect(parse({ relayer: { ...base.relayer, alerts: ['nonce 3 stuck'] } })).not.toBeNull();
  });
});

describe('RPC_URL_SEND (M-1)', () => {
  it('is optional, validated, and never part of the settings a log or the status could print', () => {
    expect(loadOnchainEnv({}).sendRpcUrl()).toBeNull();
    const url = 'https://send.example/v2/secretkey123456';
    const e = loadOnchainEnv({ RPC_URL_SEND: url });
    expect(e.sendRpcUrl()).toBe(url);
    expect(JSON.stringify(e, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('secretkey');
    expect(() => loadOnchainEnv({ RPC_URL_SEND: 'not a url' })).toThrow(/RPC_URL_SEND/);
    // The logger removes its path segments like RPC_URL's.
    expect(redact(`send failed: ${url}`, { RPC_URL_SEND: url })).not.toContain('secretkey123456');
  });
});
