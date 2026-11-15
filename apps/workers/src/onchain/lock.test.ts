import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseRedisUrl } from '@velum/config';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../lib/log';
import { loadOnchainEnv } from './env';
import { onchainDeployment } from './index';
import { lockKey, roleLock } from './lock';

/** SET NX PX and the two Lua scripts of lock.ts, with a clock. */
class FakeRedis {
  store = new Map<string, { v: string; exp: number }>();
  now = 0;
  async set(k: string, v: string, _px: 'PX', ttl: number, _nx: 'NX') {
    const e = this.store.get(k);
    if (e && e.exp > this.now) return null;
    this.store.set(k, { v, exp: this.now + ttl });
    return 'OK' as const;
  }
  async eval(script: string, _n: number, k: string, token: string, ttl?: string) {
    const e = this.store.get(k);
    if (!e || e.exp <= this.now || e.v !== token) return 0;
    if (script.includes('pexpire')) e.exp = this.now + Number(ttl);
    else this.store.delete(k);
    return 1;
  }
}

describe('role lock (one active instance per on-chain role)', () => {
  it('only one holder; renewals keep it; it passes on after release or expiry', async () => {
    const redis = new FakeRedis();
    const a = roleLock(redis as never, 'keeper:1', 30_000);
    const b = roleLock(redis as never, 'keeper:1', 30_000);
    expect(await a.hold()).toBe(true);
    expect(await b.hold()).toBe(false);
    redis.now += 20_000;
    expect(await a.hold()).toBe(true); // renewed for another 30 s
    redis.now += 20_000;
    expect(await b.hold()).toBe(false);
    await a.release();
    expect(await b.hold()).toBe(true);
    // b dies without releasing: after the TTL a takes over, and b's late renewal fails.
    redis.now += 31_000;
    expect(await a.hold()).toBe(true);
    expect(await b.hold()).toBe(false);
    expect(lockKey('keeper:1')).toBe('velum:onchain:lock:keeper:1');
  });

  it.skipIf(!process.env.TEST_REDIS_URL)('against a real Redis', async () => {
    const parsed = parseRedisUrl(process.env.TEST_REDIS_URL!);
    if (!parsed.ok) throw new Error(parsed.error);
    const redis = new Redis({ ...parsed.options, maxRetriesPerRequest: 1 });
    try {
      const role = `test:${Date.now()}`;
      const a = roleLock(redis, role, 2000);
      const b = roleLock(redis, role, 2000);
      expect(await a.hold()).toBe(true);
      expect(await b.hold()).toBe(false);
      expect(await a.hold()).toBe(true);
      await a.release();
      expect(await b.hold()).toBe(true);
      await b.release();
      expect(await redis.exists(lockKey(role))).toBe(0);
    } finally {
      await redis.quit();
    }
  });
});

describe('the on-chain workers start only with ONCHAIN_WORKERS=true and a deployment file for the chain', () => {
  const lines: string[] = [];
  const log: Logger = { debug: () => undefined, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
  const file = { chainId: 46630, startBlock: 1, contracts: { vault: A(1), oracle: A(2), spotPools: A(3), makerBook: A(4), perpsMarkets: A(5) }, tokens: { USDG: A(10) }, priceRelayer: A(9), guardian: A(0) };

  it('off by default, off without the file, off with an invalid file, on with both', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'velum-onchain-'));
    expect(onchainDeployment(loadOnchainEnv({ DEPLOYMENTS_DIR: dir }), 46630, log)).toBeNull();
    expect(lines.at(-1)).toMatch(/ONCHAIN_WORKERS is not true/);
    expect(onchainDeployment(loadOnchainEnv({ ONCHAIN_WORKERS: 'true', DEPLOYMENTS_DIR: dir }), 46630, log)).toBeNull();
    expect(lines.at(-1)).toMatch(/no deployment file/);
    writeFileSync(path.join(dir, '46630.json'), JSON.stringify({ ...file, chainId: 4663 }));
    expect(onchainDeployment(loadOnchainEnv({ ONCHAIN_WORKERS: 'true', DEPLOYMENTS_DIR: dir }), 46630, log)).toBeNull();
    expect(lines.at(-1)).toMatch(/invalid/);
    writeFileSync(path.join(dir, '46630.json'), JSON.stringify(file));
    expect(onchainDeployment(loadOnchainEnv({ DEPLOYMENTS_DIR: dir }), 46630, log)).toBeNull();
    expect(onchainDeployment(loadOnchainEnv({ ONCHAIN_WORKERS: 'true', DEPLOYMENTS_DIR: dir }), 46630, log)?.contracts.perpsMarkets).toBe(A(5));
    // A mainnet deployment file is read too (indexing mainnet is allowed); sending is guarded in the sender.
    writeFileSync(path.join(dir, '4663.json'), JSON.stringify({ ...file, chainId: 4663 }));
    expect(onchainDeployment(loadOnchainEnv({ ONCHAIN_WORKERS: 'true', DEPLOYMENTS_DIR: dir }), 4663, log)?.chainId).toBe(4663);
  });
});
