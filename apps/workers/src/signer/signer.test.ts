/**
 * The signer process (on-chain audit M-2) without a chain: its own price path (Robinhood straight, the same guards as
 * price-relay, state in its own directory, nothing from Redis), the keys file and the trusted-path rules, the state
 * directory, the single-instance lock, the settings gate and the idle statuses it reports. The anvil end to end
 * (onchain/e2e.test.ts) runs the real signer process.
 */
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAINNET_CHAIN_ID, MAINNET_TOKEN_ADDRESSES, QUOTE_FROZEN_AFTER_MS } from '@velum/config';
import { parseSignerStatus } from '@velum/config/src/onchain';
import { afterAll, describe, expect, it } from 'vitest';
import type { Logger } from '../lib/log';
import { snapshotEligibility } from '../onchain/relayer';
import { robinhoodSource } from '../sources/robinhood';
import { loadSignerEnv } from './env';
import { StateDir, readKeysFile, untrustedPath } from './files';
import { acquireInstanceLock } from './lock';
import { SignerPrices } from './prices';
import { startSigner, trustedDeployment } from './run';

// Throwaway values only (never real keys): small valid secp256k1 scalars.
const K1 = `0x${'0'.repeat(63)}1`;
const K2 = `0x${'0'.repeat(63)}2`;
// Monday 2026-11-16 15:00 UTC (10:00 ET): the session is open.
const OPEN = Date.UTC(2026, 10, 16, 15, 0, 0);
const ROOT = process.getuid?.() === 0;
const silent: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'velum-signer-'));
  chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}

/** A fake Robinhood quote API: /prices/<SYM> answers the current bid/ask; records every URL asked for. */
function fakeRobinhood(clock: () => number) {
  const quotes: Record<string, { bid: string; ask: string; token?: string }> = {};
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    const sym = decodeURIComponent(String(url).split('/').pop()!);
    const q = quotes[sym];
    if (!q) return new Response('{}', { status: 404 });
    const body = {
      quotes: [
        {
          tokenSymbol: sym,
          deployments: [{ chainId: MAINNET_CHAIN_ID, contractAddress: q.token ?? MAINNET_TOKEN_ADDRESSES[sym] }],
          tokenBid: q.bid,
          tokenAsk: q.ask,
          isTradingHalt: false,
          generatedAt: new Date(clock()).toISOString(),
        },
      ],
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { quotes, urls, fetchImpl };
}

describe('the signer reads its own prices (M-2)', () => {
  it('straight from Robinhood with the price-relay guards: unconfirmed first, live once it moves, frozen when it stops', async () => {
    let clock = OPEN;
    const rh = fakeRobinhood(() => clock);
    const feed = new SignerPrices({ source: robinhoodSource(silent, rh.fetchImpl, { symbols: ['TSLA'] }), symbols: ['TSLA'], log: silent, now: () => clock });
    rh.quotes.TSLA = { bid: '391.60', ask: '391.70' };
    await feed.poll();
    // Only the Robinhood quote API, only the deployment's market.
    expect(rh.urls).toEqual(['https://api.robinhood.com/rhj/prices/TSLA']);
    let snap = (await feed.snapshots(['TSLA'])).get('TSLA');
    // Seen without a previous quote: its time is unknown, so it is not pushed until it changes (audit F-6).
    expect(snapshotEligibility(snap, clock)).toEqual({ ok: false, reason: 'unconfirmed' });
    clock += 2000;
    rh.quotes.TSLA = { bid: '391.80', ask: '391.90' };
    await feed.poll();
    snap = (await feed.snapshots(['TSLA'])).get('TSLA');
    expect(snapshotEligibility(snap, clock)).toEqual({ ok: true, price: 39185n * 10n ** 16n });
    expect(feed.status().markets).toEqual({ TSLA: 'live' });
    // The quote stops changing: it keeps its time and ages out (a closed or frozen upstream).
    const quoteAt = clock;
    clock += QUOTE_FROZEN_AFTER_MS + 1000;
    await feed.poll();
    snap = (await feed.snapshots(['TSLA'])).get('TSLA');
    expect(snap!.updatedAt).toBe(quoteAt);
    expect(snapshotEligibility(snap, clock)).toEqual({ ok: false, reason: 'frozen' });
    // A quote for another token address with the same ticker is never used.
    rh.quotes.TSLA = { bid: '391.90', ask: '392.00', token: '0x000000000000000000000000000000000000dead' };
    clock += 2000;
    await feed.poll();
    expect((await feed.snapshots(['TSLA'])).get('TSLA')!.price).toBe('391.85');
  });

  it('holds a jump back until three quotes agree, seeded from the chain when it has no quote of its own', async () => {
    let clock = OPEN;
    const rh = fakeRobinhood(() => clock);
    const feed = new SignerPrices({ source: robinhoodSource(silent, rh.fetchImpl, { symbols: ['TSLA'] }), symbols: ['TSLA'], log: silent, now: () => clock });
    feed.setReference('TSLA', '391.65'); // the price last relayed on chain
    expect(feed.unseeded()).toEqual([]);
    rh.quotes.TSLA = { bid: '600', ask: '600.10' }; // +53%: a glitch until confirmed
    for (let i = 0; i < 2; i++) {
      await feed.poll();
      clock += 2000;
      expect((await feed.snapshots(['TSLA'])).get('TSLA')).toBeUndefined();
    }
    await feed.poll();
    expect((await feed.snapshots(['TSLA'])).get('TSLA')!.price).toBe('600.05');
  });

  it('keeps its last quote in its own state directory, so a restart neither unfreezes a quote nor forgets it', async () => {
    const dir = scratch();
    const state = new StateDir(path.join(dir, 'state'));
    let clock = OPEN;
    const rh = fakeRobinhood(() => clock);
    const make = () => new SignerPrices({ source: robinhoodSource(silent, rh.fetchImpl, { symbols: ['TSLA'] }), symbols: ['TSLA'], state: state.store('last-quotes'), log: silent, now: () => clock });
    const a = make();
    rh.quotes.TSLA = { bid: '391.60', ask: '391.70' };
    await a.poll();
    clock += 2000;
    rh.quotes.TSLA = { bid: '391.80', ask: '391.90' };
    await a.poll();
    const quoteAt = clock;
    expect(statSync(path.join(dir, 'state', 'last-quotes.json')).mode & 0o777).toBe(0o600);
    // Restart with the quote unchanged: confirmed at once, and it keeps its old quote time.
    clock += 5 * 60_000;
    const b = make();
    await b.poll();
    const snap = (await b.snapshots(['TSLA'])).get('TSLA')!;
    expect(snap.unconfirmed).toBeUndefined();
    expect(snap.updatedAt).toBe(quoteAt);
    // A state file another market's entry or a malformed value is ignored.
    state.write('last-quotes', { v: 1, markets: { TSLA: { price: 'NaN', updatedAt: 1, checkedAt: 1 }, AMZN: { price: '1', updatedAt: 1, checkedAt: 1 } } });
    const c = make();
    expect(await c.snapshots(['TSLA', 'AMZN'])).toEqual(new Map());
  });
});

describe('the keys file (M-2)', () => {
  const write = (dir: string, text: string, mode = 0o600) => {
    const f = path.join(dir, 'signer-keys.env');
    writeFileSync(f, text);
    chmodSync(f, mode);
    return f;
  };
  it('reads the two hot keys, never printing them', () => {
    const dir = scratch();
    const r = readKeysFile(write(dir, `# keys\nPRICE_RELAY_PRIVATE_KEY=${K1}\nKEEPER_PRIVATE_KEY="${K2}"\nOTHER=1\n`));
    expect(r.problems).toEqual([]);
    expect(r.keys.relay()).toBe(K1);
    expect(r.keys.keeper()).toBe(K2);
    expect(JSON.stringify(r)).not.toContain(K1.slice(2));
  });
  it('refuses a file others can read, its group can write, a duplicate, a malformed key or one key for both roles', () => {
    const dir = scratch();
    expect(readKeysFile(write(dir, `PRICE_RELAY_PRIVATE_KEY=${K1}\n`, 0o644)).problems[0]).toMatch(/must not be writable by its group nor readable by others/);
    expect(readKeysFile(write(dir, `PRICE_RELAY_PRIVATE_KEY=${K1}\n`, 0o660)).problems[0]).toMatch(/writable by (its )?group/);
    expect(readKeysFile(write(dir, `PRICE_RELAY_PRIVATE_KEY=${K1}\n`, 0o640)).problems).toEqual([]);
    const dup = readKeysFile(write(dir, `PRICE_RELAY_PRIVATE_KEY=${K1}\nPRICE_RELAY_PRIVATE_KEY=${K2}\n`));
    expect(dup.problems).toEqual(['PRICE_RELAY_PRIVATE_KEY is set on more than one line in SIGNER_KEYS_FILE']);
    expect(dup.keys.relay()).toBeNull();
    const bad = readKeysFile(write(dir, `KEEPER_PRIVATE_KEY=0x${'z'.repeat(64)}\n`));
    expect(bad.problems[0]).toMatch(/^KEEPER_PRIVATE_KEY in SIGNER_KEYS_FILE is not a private key/);
    expect(bad.problems.join(' ')).not.toContain('z'.repeat(64));
    const same = readKeysFile(write(dir, `PRICE_RELAY_PRIVATE_KEY=${K1}\nKEEPER_PRIVATE_KEY=${K1}\n`));
    expect(same.keys.keeper()).toBeNull();
    expect(same.problems[0]).toMatch(/must not be the price-relay key/);
    expect(readKeysFile(path.join(dir, 'missing.env')).problems[0]).toMatch(/does not exist/);
  });
  it.skipIf(!ROOT)('refuses a keys file on a path another user can change, or owned by another user', () => {
    const dir = scratch();
    const open = path.join(dir, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777); // world-writable, not sticky: anyone could replace the file
    expect(readKeysFile(write(open, `PRICE_RELAY_PRIVATE_KEY=${K1}\n`)).problems[0]).toMatch(/writable by group or others/);
    const theirs = path.join(dir, 'theirs');
    mkdirSync(theirs);
    chownSync(theirs, 1000, 1000);
    expect(readKeysFile(write(theirs, `PRICE_RELAY_PRIVATE_KEY=${K1}\n`)).problems[0]).toMatch(/belongs to another user/);
    const f = write(dir, `PRICE_RELAY_PRIVATE_KEY=${K1}\n`);
    chownSync(f, 1000, 1000);
    expect(readKeysFile(f).problems[0]).toMatch(/belongs to another user/);
    // A link to a good file through a directory another user owns is refused too.
    const linkDir = path.join(dir, 'links');
    mkdirSync(linkDir);
    chownSync(linkDir, 1000, 1000);
    const good = write(scratch(), `PRICE_RELAY_PRIVATE_KEY=${K1}\n`);
    symlinkSync(good, path.join(linkDir, 'k.env'));
    expect(untrustedPath(path.join(linkDir, 'k.env'))).toMatch(/belongs to another user/);
    // /tmp-like sticky root directories are fine on the way.
    expect(untrustedPath(good)).toBeNull();
  });
});

describe('the state directory and the instance lock', () => {
  it('state is created 0700 and refused when open to others', () => {
    const dir = scratch();
    const s = new StateDir(path.join(dir, 'state'));
    expect(statSync(s.dir).mode & 0o777).toBe(0o700);
    s.write('x', { a: 1 });
    expect(s.read('x')).toEqual({ a: 1 });
    const open = path.join(dir, 'open');
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(() => new StateDir(open)).toThrow(/closed to group and others/);
    symlinkSync(s.dir, path.join(dir, 'link'));
    expect(() => new StateDir(path.join(dir, 'link'))).toThrow(/not a directory/);
  });
  it('one instance at a time; a socket left by a crash is replaced', async () => {
    const dir = scratch();
    const sock = path.join(dir, 'signer.lock');
    const a = await acquireInstanceLock(sock);
    expect(a).not.toBeNull();
    expect(await acquireInstanceLock(sock)).toBeNull();
    await a!.release();
    const b = await acquireInstanceLock(sock);
    expect(b).not.toBeNull();
    await b!.release();
  });
});

describe('signer settings and gating', () => {
  it('reads paths and the shared on-chain settings; refuses the test-only settings off anvil', () => {
    const base = { CHAIN_ID: '46630', HOME: '/home/velum-signer' };
    const ok = loadSignerEnv(base);
    expect(ok.env).toMatchObject({ chainId: 46630, keysFile: '/etc/velum/signer-keys.env', statusFile: '/run/velum-signer/status.json', stateDir: '/home/velum-signer/state', envKeys: [] });
    expect(ok.env!.onchain.requested).toBe(false);
    expect(loadSignerEnv({ ...base, SIGNER_TEST_PRICES_URL: 'http://127.0.0.1:9/p' }).error).toMatch(/SIGNER_TEST_\* settings are refused on chain 46630/);
    expect(loadSignerEnv({ ...base, CHAIN_ID: '31337', SIGNER_TEST_PRICES_URL: 'http://127.0.0.1:9/p', SIGNER_TEST_CLOCK_OFFSET_MS: '5' }).env!.test).toEqual({ pricesUrl: 'http://127.0.0.1:9/p', assetsUrl: null, clockOffsetMs: 5 });
    expect(loadSignerEnv({ ...base, CHAIN_ID: '31337', SIGNER_TEST_PRICES_URL: 'https://evil.example/p' }).error).toMatch(/must be an http:\/\/127\.0\.0\.1/);
    expect(loadSignerEnv({ ...base, CHAIN_ID: '4663' }).error).toMatch(/CHAIN_ID 4663 does not match/);
    expect(loadSignerEnv({ ...base, SIGNER_KEYS_FILE: 'relative.env' }).error).toMatch(/SIGNER_KEYS_FILE must be an absolute path/);
    // Hot keys in its environment are noted by name and never used.
    const withKeys = loadSignerEnv({ ...base, PRICE_RELAY_PRIVATE_KEY: K1 });
    expect(withKeys.env!.envKeys).toEqual(['PRICE_RELAY_PRIVATE_KEY']);
    expect(JSON.stringify(withKeys, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(K1.slice(2));
  });

  it('idle with the reason (not requested, no deployment file, an untrusted deployment path), status file 640', async () => {
    const dir = scratch();
    const statusFile = path.join(dir, 'status.json');
    const env = (o: Record<string, string>) => loadSignerEnv({ CHAIN_ID: '31337', HOME: dir, SIGNER_STATUS_FILE: statusFile, SIGNER_KEYS_FILE: path.join(dir, 'keys.env'), SIGNER_DEPLOYMENTS_DIR: path.join(dir, 'deployments'), ...o }).env!;
    const read = () => parseSignerStatus(readFileSync(statusFile, 'utf8'), Date.now())!;
    let h = await startSigner({ env: env({}), log: silent });
    expect(read()).toMatchObject({ requested: false, error: null, relayer: { enabled: false }, keeper: { enabled: false } });
    expect(statSync(statusFile).mode & 0o777).toBe(0o640);
    await h.stop();
    h = await startSigner({ env: env({ ONCHAIN_WORKERS: 'true' }), log: silent });
    expect(read()).toMatchObject({ requested: true, deployment: '', error: expect.stringMatching(/^no deployment file for chain 31337/) });
    await h.stop();
    if (ROOT) {
      const d = path.join(dir, 'deployments');
      mkdirSync(d);
      writeFileSync(path.join(d, '31337.json'), '{}');
      chownSync(d, 1000, 1000); // a directory another user (say, the app user) could write
      expect(trustedDeployment(d, 31337).error).toMatch(/on a path another user can change/);
    }
  });
});
