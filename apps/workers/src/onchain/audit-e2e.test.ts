/**
 * End to end of the on-chain workers audit fixes (2026-11) on anvil, run by apps/workers/e2e/onchain-e2e.sh after
 * e2e.test.ts and the API end to end (same chain, scratch Postgres and unix-socket Redis; skipped without
 * VELUM_E2E_RPC). The auditor's reproductions, inverted:
 *  R1, M-1  an RPC that withholds the relayer's transactions and lands an old signed push minutes later: the push
 *           now reverts on chain (PushExpired), the price stays stale, no open goes through; the sender keeps
 *           cancelling the stuck nonce and alerts; a separate send endpoint (RPC_URL_SEND) gets pushes through.
 *  R2, M-3  role locks held by someone else on Velum's Redis: /v1/health's on-chain summary is not ok and says why.
 *  R5, L-2  anyone can fill one block with more FundingAdvanced logs than the provider returns: the indexer reads
 *           that block with eth_getBlockReceipts and goes on, with one funding point for the block.
 *  L-3      the keeper liquidates hundreds of liquidatable positions well within the 572 s keeper window.
 * Only anvil's public test accounts sign, with keys derived from anvil's public test mnemonic.
 */
import { createServer, type Server } from 'node:http';
import { cacheKeys, parseRedisUrl, type MarketSnapshot } from '@velum/config';
import { createCacheMac } from '@velum/config/src/cache-mac';
import { readDeploymentFile } from '@velum/config/src/deployment-file';
import { ONCHAIN_STATUS_KEY, parseOnchainStatus, type Deployment } from '@velum/config/src/onchain';
import { PrismaClient } from '@velum/db';
import { Redis } from 'ioredis';
import { createWalletClient, decodeFunctionData, encodeFunctionData, http, keccak256, parseAbi, parseEventLogs, parseTransaction, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onchainSummary } from '../../../api/src/routes/health';
import type { Logger } from '../lib/log';
import { abis, chainFor, publicClientFor } from './chain';
import { loadOnchainEnv } from './env';
import { startOnchain } from './index';
import { Indexer } from './indexer';
import { Keeper } from './keeper';
import { lockKey } from './lock';
import { PriceRelayer } from './relayer';
import { TxSender, type SendChain, type SenderChain } from './tx-sender';

const RPC = process.env.VELUM_E2E_RPC;
const DIR = process.env.VELUM_E2E_DEPLOYMENTS ?? '';
const DB = process.env.TEST_DATABASE_URL ?? '';
const REDIS = process.env.TEST_REDIS_URL ?? '';
const CHAIN_ID = 31337;
const MNEMONIC = 'test test test test test test test test test test test junk';
const keyOf = (i: number): Hex => toHex(mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey!);
const MOCK_ABI = parseAbi(['function mint(address to, uint256 amount)', 'function approve(address spender, uint256 amount) returns (bool)']);
const E6 = 1_000_000n;
const MAX = 2n ** 256n - 1n;
const GWEI = 10n ** 9n;
// Monday 2026-11-16 10:00 US Eastern: the session calendar is open on the injected clock.
const OPEN = Date.UTC(2026, 10, 16, 15, 0, 0);
/** The keeper window the contracts guarantee between "liquidatable" and "insolvent" (contracts/README.md). */
const KEEPER_WINDOW_S = 572;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, everyMs = 300): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (err) {
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
}
async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

function captureLogger(lines: string[]): Logger {
  const write = (level: string) => (msg: string, data?: Record<string, unknown>) => {
    lines.push(JSON.stringify({ level, msg, ...data }));
    if (level === 'error') process.stderr.write(`${JSON.stringify({ level, msg, ...data })}\n`);
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

/** A JSON-RPC proxy in front of anvil that, while `withhold` is on, keeps every eth_sendRawTransaction and answers its hash. */
function withholdingProxy(upstream: string) {
  const held: Hex[] = [];
  const state = { withhold: false };
  type Msg = { jsonrpc: string; id: number | string; method: string; params?: unknown[] };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const parsed = JSON.parse(body) as Msg | Msg[];
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const local: Array<{ jsonrpc: string; id: number | string; result: unknown }> = [];
      const fwd: Msg[] = [];
      for (const m of arr) {
        if (state.withhold && m.method === 'eth_sendRawTransaction') {
          const raw = (m.params as Hex[])[0]!;
          held.push(raw);
          local.push({ jsonrpc: '2.0', id: m.id, result: keccak256(raw) });
        } else fwd.push(m);
      }
      let fres: Array<{ id: number | string }> = [];
      if (fwd.length) {
        const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fwd) });
        const j = (await r.json()) as { id: number | string } | Array<{ id: number | string }>;
        fres = Array.isArray(j) ? j : [j];
      }
      const all = [...local, ...fres];
      const out = Array.isArray(parsed) ? arr.map((m) => all.find((x) => x.id === m.id)) : all[0];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  return { server, held, state };
}

describe.skipIf(!RPC)('on-chain workers audit end to end (anvil)', () => {
  let d: Deployment;
  let prisma: PrismaClient;
  let redis: Redis;
  let client: PublicClient;
  const lines: string[] = [];
  const log = captureLogger(lines);
  const t0 = Date.now();
  const clock = () => OPEN + (Date.now() - t0);
  const target: Record<string, string> = {};
  let feeder: NodeJS.Timeout | undefined;
  const relayKey = keyOf(1);
  const relayAcc = privateKeyToAccount(relayKey);
  const keeperKey = keyOf(2);
  const mac = () => createCacheMac(DB, 'testnet');

  const chain = () => chainFor(CHAIN_ID, RPC!);
  const wallet = (account: ReturnType<typeof privateKeyToAccount>) => createWalletClient({ account, chain: chain(), transport: http(RPC!) });
  const acc = (i: number) => privateKeyToAccount(keyOf(i));
  const call = (abi: readonly unknown[], functionName: string, args: readonly unknown[]): Hex =>
    (encodeFunctionData as (p: { abi: unknown; functionName: string; args: readonly unknown[] }) => Hex)({ abi, functionName, args });
  /** Sends and waits for the receipt, polling every 25 ms (anvil mines at once). */
  async function send(account: ReturnType<typeof privateKeyToAccount>, to: Address, data: Hex, o: { value?: bigint; gas?: bigint; nonce?: number; wait?: boolean } = {}) {
    const hash = await wallet(account).sendTransaction({ account, to, data, value: o.value ?? 0n, gas: o.gas, nonce: o.nonce, chain: chain() });
    if (o.wait === false) return { hash, status: 'pending' as const, block: 0n };
    const r = await waitFor('receipt', async () => client.getTransactionReceipt({ hash }).catch(() => null), 30_000, 25);
    return { hash, status: r.status, block: r.blockNumber };
  }
  async function sendOk(account: ReturnType<typeof privateKeyToAccount>, to: Address, data: Hex, value = 0n) {
    const r = await send(account, to, data, { value });
    if (r.status !== 'success') throw new Error(`transaction reverted: ${r.hash}`);
    return r;
  }
  const relayed = async (sym: string) => (await client.readContract({ address: d.contracts.oracle, abi: abis.oracle, functionName: 'relayed', args: [d.tokens[sym]!] })) as readonly [bigint, bigint, bigint];
  const bandLast = async (sym: string) => ((await client.readContract({ address: d.contracts.oracle, abi: abis.oracle, functionName: 'bands', args: [d.tokens[sym]!] })) as readonly [bigint, bigint, bigint])[0];
  /**
   * The relay key pushes `price` for TSLA, observed at the time of a block mined just before, one second after the
   * previous one (anvil can make blocks within the same second; the adapter allows one push per token per second).
   */
  async function pushNow(price: bigint) {
    await rpc('evm_increaseTime', [1]);
    await rpc('evm_mine');
    const ts = (await client.getBlock({ blockTag: 'latest' })).timestamp;
    return sendOk(relayAcc, d.contracts.oracle, call(abis.oracle, 'pushPrices', [[d.tokens.TSLA!], [price], ts]));
  }

  function writeSnapshots(): Promise<unknown> {
    const now = clock();
    const pipe = redis.pipeline();
    for (const [symbol, price] of Object.entries(target)) {
      const snap: MarketSnapshot = { symbol, price, mark: price, open24h: price, spark: [price], source: 'robinhood', updatedAt: now, checkedAt: now };
      pipe.set(cacheKeys.price(symbol), mac().seal(cacheKeys.price(symbol), JSON.stringify(snap)));
    }
    return pipe.exec();
  }

  beforeAll(async () => {
    const read = readDeploymentFile(DIR, CHAIN_ID);
    if (read.status !== 'ok') throw new Error(`deployment file: ${read.status}`);
    d = read.deployment;
    prisma = new PrismaClient({ datasources: { db: { url: DB } } });
    const parsed = parseRedisUrl(REDIS);
    if (!parsed.ok) throw new Error(parsed.error);
    redis = new Redis({ ...parsed.options, maxRetriesPerRequest: null });
    client = publicClientFor(CHAIN_ID, RPC!);
    // anvil funds only its first ten accounts: the extra ones used here get test ether.
    for (let i = 10; i <= 15; i++) await rpc('anvil_setBalance', [acc(i).address, toHex(100n * 10n ** 18n)]);
    // Start from the price the earlier tests left on chain, so the first push is not rate-limited.
    const last = await bandLast('TSLA');
    target.TSLA = last > 0n ? (Number(last / 10n ** 14n) / 1e4).toFixed(4) : '391.65';
    await writeSnapshots();
    feeder = setInterval(() => void writeSnapshots(), 500);
  }, 60_000);

  afterAll(async () => {
    if (feeder) clearInterval(feeder);
    await prisma?.$disconnect();
    await redis?.quit();
  }, 60_000);

  it('R1 (M-1): a withheld push landed minutes later reverts on chain; the sender keeps cancelling and alerts; RPC_URL_SEND gets through', async () => {
    const proxy = withholdingProxy(RPC!);
    await new Promise<void>((r) => proxy.server.listen(0, '127.0.0.1', () => r()));
    const proxied = publicClientFor(CHAIN_ID, `http://127.0.0.1:${(proxy.server.address() as { port: number }).port}`);
    const sender = new TxSender(proxied as unknown as SenderChain, relayAcc, { role: 'relayer', chainId: CHAIN_ID, maxFeeWei: 50n * GWEI, minBalanceWei: 0n, mainnetConfirmed: false, stuckAfterMs: 1500, log });
    await sender.init();
    const relayer = new PriceRelayer({ client: proxied, sender, redis, mac: mac(), deployment: d, chainId: CHAIN_ID, intervalMs: 8000, log, now: clock });
    let running = true;
    const loop = (async () => {
      while (running) {
        await relayer.tick();
        await sleep(300);
      }
    })();
    try {
      // Honest RPC: a push lands.
      const before = await relayed('TSLA');
      await waitFor('a push through the honest RPC', async () => (await relayed('TSLA'))[1] > before[1], 60_000);
      // The RPC withholds; the quote keeps moving, so every signed version carries another price.
      proxy.state.withhold = true;
      const base = Number(target.TSLA);
      let k = 0;
      const mover = setInterval(() => (target.TSLA = (base + 0.05 * Math.min(++k, 8)).toFixed(4)), 1200);
      await waitFor('the payload replacements to run out', async () => relayer.status().stuck && (relayer.status().alerts ?? []).length > 0, 120_000);
      clearInterval(mover);
      expect((relayer.status().alerts ?? [])[0]).toMatch(/^nonce \d+ \(push:TSLA\) not mined after 6 replacements: cancelling it/);
      const nonce = sender.pending()!.nonce;
      const decoded = () =>
        proxy.held.map((raw) => {
          const tx = parseTransaction(raw);
          if (tx.nonce !== nonce) return 'other';
          if (!tx.data || tx.data === '0x') return 'cancel';
          return decodeFunctionData({ abi: abis.oracle, data: tx.data }).functionName;
        });
      // M-1, worker side: the nonce is never abandoned: cancellations keep going out after the payloads ran out.
      const heldAtStuck = proxy.held.length;
      await waitFor('cancellations of the stuck nonce', async () => decoded().filter((x) => x === 'cancel').length >= 2 && proxy.held.length > heldAtStuck, 30_000);
      expect(decoded().slice(0, 7)).toEqual(Array(7).fill('pushPrices'));

      // Real time passes (3 minutes) and the market falls 3%; the RPC lands the OLDEST signed push.
      target.TSLA = (base * 0.97).toFixed(4);
      await rpc('evm_increaseTime', [180]);
      await rpc('evm_mine');
      const [p0, at0] = await relayed('TSLA');
      const hash = await rpc<Hex>('eth_sendRawTransaction', [proxy.held[0]!]);
      const rcpt = await client.waitForTransactionReceipt({ hash, pollingInterval: 50 });
      // M-1, contract side: it reverts (PushExpired) instead of landing as a fresh price.
      expect(rcpt.status).toBe('reverted');
      const args = decodeFunctionData({ abi: abis.oracle, data: parseTransaction(proxy.held[0]!).data! }).args as readonly [readonly Address[], readonly bigint[], bigint];
      await expect(client.simulateContract({ account: relayAcc.address, address: d.contracts.oracle, abi: abis.oracle, functionName: 'pushPrices', args, blockNumber: rcpt.blockNumber })).rejects.toThrow(/PushExpired/);
      expect(await relayed('TSLA')).toEqual(expect.arrayContaining([p0, at0]));
      await expect(client.readContract({ address: d.contracts.oracle, abi: abis.oracle, functionName: 'price', args: [d.tokens.TSLA!] })).rejects.toThrow(/StalePrice/);

      // Its nonce is used now (by the old, reverted push): the sender reports it, the relayer backs off and alerts,
      // then pushes again once the RPC stops withholding.
      await waitFor('the relayer to see the reverted push', async () => (relayer.status().alerts ?? []).some((a) => /price push reverted/.test(a)), 30_000);
      expect(relayer.status().stuck).toBe(false);
      proxy.state.withhold = false;
      const at1 = (await relayed('TSLA'))[1];
      await waitFor('a fresh push after the withholding ended', async () => (await relayed('TSLA'))[1] > at1, 60_000);
      await waitFor('the alerts to clear', async () => (relayer.status().alerts ?? []).length === 0, 30_000);
      expect(await client.readContract({ address: d.contracts.oracle, abi: abis.oracle, functionName: 'price', args: [d.tokens.TSLA!] })).toBeGreaterThan(0n);
    } finally {
      running = false;
      await loop;
    }

    // RPC_URL_SEND: with a trusted send endpoint, a withholding RPC_URL no longer stalls the relayer.
    proxy.state.withhold = true;
    const heldBefore = proxy.held.length;
    const direct = publicClientFor(CHAIN_ID, RPC!);
    const sender2 = new TxSender(proxied as unknown as SenderChain, relayAcc, { role: 'relayer', chainId: CHAIN_ID, maxFeeWei: 50n * GWEI, minBalanceWei: 0n, mainnetConfirmed: false, stuckAfterMs: 1500, log, send: direct as unknown as SendChain });
    await sender2.init();
    const relayer2 = new PriceRelayer({ client: proxied, sender: sender2, redis, mac: mac(), deployment: d, chainId: CHAIN_ID, intervalMs: 8000, log, now: clock });
    const at2 = (await relayed('TSLA'))[1];
    running = true;
    const loop2 = (async () => {
      while (running) {
        await relayer2.tick();
        await sleep(300);
      }
    })();
    try {
      await waitFor('a push through RPC_URL_SEND while RPC_URL withholds', async () => (await relayed('TSLA'))[1] > at2, 60_000);
      expect(proxy.held.length).toBe(heldBefore);
    } finally {
      running = false;
      await loop2;
      proxy.server.close();
    }
  }, 300_000);

  it('R2 (M-3): role locks held by someone else on the same Redis: the on-chain summary is not ok and names each role', async () => {
    const id = d.contracts.perpsMarkets;
    for (const role of ['relayer', 'keeper', 'indexer']) await redis.set(lockKey(`${role}:${CHAIN_ID}:${id}`), 'squatter', 'PX', 3_600_000);
    const env = loadOnchainEnv({ ONCHAIN_WORKERS: 'true', DEPLOYMENTS_DIR: DIR, PRICE_RELAY_PRIVATE_KEY: relayKey, KEEPER_PRIVATE_KEY: keeperKey, PRICE_PUSH_INTERVAL_MS: '8000', RELAYER_MAX_GWEI: '50', KEEPER_MAX_GWEI: '50', INDEXER_POLL_MS: '500', KEEPER_INTERVAL_MS: '1000' });
    const handle = (await startOnchain({ env, chainId: CHAIN_ID, rpcUrl: RPC!, prisma, redis, mac: mac(), log, now: clock }))!;
    expect(handle).not.toBeNull();
    const summary = async () => {
      await handle.writeStatus();
      const status = parseOnchainStatus(mac().open(ONCHAIN_STATUS_KEY, await redis.get(ONCHAIN_STATUS_KEY), 16 * 1024), Date.now());
      return onchainSummary(status, Date.now(), () => true)!;
    };
    try {
      await sleep(3000);
      const s = await summary();
      expect(s.ok).toBe(false);
      for (const role of ['relayer', 'keeper', 'indexer']) expect(s.reasons).toContainEqual(expect.stringMatching(new RegExp(`^${role}: this process does not hold the role's lock`)));
      // The squatter leaves: the roles take their locks, run, and the summary is ok again.
      for (const role of ['relayer', 'keeper', 'indexer']) await redis.del(lockKey(`${role}:${CHAIN_ID}:${id}`));
      const at = (await relayed('TSLA'))[1];
      await waitFor('a push once the relayer holds its lock', async () => (await relayed('TSLA'))[1] > at, 60_000);
      const ok = await waitFor('the summary to be ok', async () => {
        const x = await summary();
        return x.ok ? x : null;
      }, 30_000, 1000);
      expect(ok.reasons).toEqual([]);
    } finally {
      await handle.stop();
    }
  }, 120_000);

  it('R5 (L-2): a block with more FundingAdvanced logs than the provider returns no longer stalls the indexer', async () => {
    await pushNow(await bandLast('TSLA')); // advanceFunding needs a price at most 60 s old
    const attacker = acc(15); // never allowlisted, no deposit: advanceFunding is permissionless
    const N = 320;
    const nonce = await client.getTransactionCount({ address: attacker.address, blockTag: 'latest' });
    const data = call(abis.perpsMarkets, 'advanceFunding', [d.tokens.TSLA!]);
    await rpc('evm_setAutomine', [false]);
    try {
      await Promise.all(Array.from({ length: N }, (_, i) => send(attacker, d.contracts.perpsMarkets, data, { gas: 90_000n, nonce: nonce + i, wait: false })));
      await rpc('evm_mine');
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
    const spamBlock = await client.getBlockNumber({ cacheTime: 0 });
    const logs = await client.getLogs({ address: d.contracts.perpsMarkets, fromBlock: spamBlock, toBlock: spamBlock });
    expect(logs.length).toBe(N);
    for (let k = 0; k < 3; k++) await rpc('evm_mine');
    // A provider that answers at most 300 logs per eth_getLogs (caps vary: 10,000 is common, some return less).
    const CAP = 300;
    const capped = new Proxy(client, {
      get(t, p, r) {
        if (p === 'getLogs') {
          return async (args: Parameters<PublicClient['getLogs']>[0]) => {
            const out = await t.getLogs(args);
            if (out.length > CAP) throw new Error(`Log response size exceeded: more than ${CAP} logs in the response`);
            return out;
          };
        }
        return Reflect.get(t, p, r) as unknown;
      },
    }) as PublicClient;
    const key = { chainId: CHAIN_ID, deployment: d.contracts.perpsMarkets };
    await prisma.indexerCheckpoint.deleteMany({ where: key });
    const indexer = new Indexer({ client: capped, prisma, deployment: d, chainId: CHAIN_ID, confirmations: 1, chunkBlocks: 2000, startBlock: Number(spamBlock) - 3, log });
    const cp = await waitFor('the indexer past the spam block', async () => {
      await indexer.tick();
      const c = await prisma.indexerCheckpoint.findUnique({ where: { chainId_deployment: key } });
      return c && c.block > spamBlock ? c : null;
    }, 60_000, 500);
    expect(cp.block).toBeGreaterThan(spamBlock);
    expect(indexer.status().error).toBeNull();
    expect(await prisma.chainEvent.count({ where: { chainId: CHAIN_ID, block: spamBlock, kind: 'FundingAdvanced' } })).toBe(N);
    expect(await prisma.fundingPoint.count({ where: { chainId: CHAIN_ID, block: spamBlock } })).toBe(1);
    expect(lines.some((l) => l.includes('eth_getLogs refused a single block'))).toBe(true);
  }, 180_000);

  it(`L-3: the keeper liquidates hundreds of liquidatable positions well within the ${KEEPER_WINDOW_S} s keeper window`, async () => {
    const N = 220;
    const { vault, perpsMarkets: perps, makerBook: book } = d.contracts;
    const usdg = d.tokens.USDG!;
    const tsla = d.tokens.TSLA!;
    const maker = acc(10);
    const takers = [11, 12, 13, 14].map(acc);
    for (const [a, amount] of [[maker, 100_000n * E6], ...takers.map((t) => [t, 10_000n * E6] as const)] as const) {
      await sendOk(a, usdg, call(MOCK_ABI, 'mint', [a.address, amount]));
      await sendOk(a, usdg, call(MOCK_ABI, 'approve', [vault, MAX]));
      await sendOk(a, vault, call(abis.vault, 'deposit', [usdg, (amount * 3n) / 4n, a.address]));
      await sendOk(a, vault, call(abis.vault, 'setApproval', [perps, true]));
    }
    await sendOk(maker, vault, call(abis.vault, 'setApproval', [book, true]));
    const now = (await client.getBlock({ blockTag: 'latest' })).timestamp;
    const posted = await sendOk(maker, book, call(abis.makerBook, 'postOffer', [tsla, 60_000n * E6, 1_000n * E6, 10, 10, now + 30n * 86_400n]));
    const offer = parseEventLogs({ abi: abis.makerBook, logs: (await client.getTransactionReceipt({ hash: posted.hash })).logs, eventName: 'OfferPosted' })[0]!.args.id;
    const firstId = (await client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'nextPositionId' })) as bigint;

    // N 5x longs of 50 USDG at the current price, in blocks of 44 opens behind a fresh push (opens need <= 10 s).
    const P0 = await bandLast('TSLA');
    const nonces = await Promise.all(takers.map((t) => client.getTransactionCount({ address: t.address, blockTag: 'latest' })));
    const open = call(abis.perpsMarkets, 'open', [offer, tsla, true, 50n * E6, 10, MAX]);
    const PER_BLOCK = 44;
    for (let b = 0; b < N / PER_BLOCK; b++) {
      await pushNow(P0);
      await rpc('evm_setAutomine', [false]);
      try {
        await Promise.all(
          Array.from({ length: PER_BLOCK }, (_, i) => {
            const nonce = nonces[i % 4]!;
            nonces[i % 4] = nonce + 1;
            return send(takers[i % 4]!, perps, open, { gas: 600_000n, nonce, wait: false });
          }),
        );
        await rpc('evm_mine');
      } finally {
        await rpc('evm_setAutomine', [true]);
      }
    }
    const lastId = (await client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'nextPositionId' })) as bigint;
    expect(lastId - firstId).toBe(BigInt(N));

    // The price falls 12.5% at the rate limit (5% per 5 minutes): every 5x long becomes liquidatable, none insolvent.
    const P1 = (P0 * 875n) / 1000n;
    for (let i = 0; i < 4 && (await bandLast('TSLA')) > P1; i++) {
      await rpc('evm_increaseTime', [300]);
      await pushNow(P1);
    }
    expect(await bandLast('TSLA')).toBe(P1);
    const liquidatable = await Promise.all(Array.from({ length: N }, (_, i) => client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'isLiquidatable', args: [firstId + BigInt(i)] }) as Promise<boolean>));
    expect(liquidatable.every(Boolean)).toBe(true);

    // The keeper, as the workers run it: one transaction in flight, a tick every second. The relay keeps the price
    // fresh meanwhile (liquidations need a price at most 60 s old).
    let refreshing = true;
    const refresher = (async () => {
      while (refreshing) {
        await sleep(5000);
        if (refreshing) await pushNow(P1).catch((e: unknown) => log.warn('refresh push failed', { err: String(e) }));
      }
    })();
    const keeperSender = new TxSender(client as unknown as SenderChain, acc(2), { role: 'keeper', chainId: CHAIN_ID, maxFeeWei: 50n * GWEI, minBalanceWei: 0n, mainnetConfirmed: false, stuckAfterMs: 15_000, log });
    await keeperSender.init();
    const keeper = new Keeper({ client, sender: keeperSender, prisma, deployment: d, chainId: CHAIN_ID, fundingEpochSeconds: 7 * 86_400, ethPriceUsd: 1n, maxFeeWei: 50n * GWEI, log });
    const started = Date.now();
    let closed = 0;
    try {
      while (Date.now() - started < KEEPER_WINDOW_S * 1000) {
        await keeper.tick();
        const open = await Promise.all(Array.from({ length: N }, (_, i) => client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'getPosition', args: [firstId + BigInt(i)] }) as Promise<{ open: boolean }>));
        closed = open.filter((p) => !p.open).length;
        if (closed === N) break;
        await sleep(1000);
      }
    } finally {
      refreshing = false;
      await refresher;
    }
    const elapsedS = (Date.now() - started) / 1000;
    process.stderr.write(`L-3 keeper: ${closed} of ${N} liquidations in ${elapsedS.toFixed(1)} s (${(closed / elapsedS).toFixed(2)} per second)\n`);
    expect(closed).toBe(N);
    expect(elapsedS).toBeLessThan(KEEPER_WINDOW_S);
    expect(keeper.status().liquidations).toBeGreaterThanOrEqual(N);
  }, (KEEPER_WINDOW_S + 180) * 1000);
});
