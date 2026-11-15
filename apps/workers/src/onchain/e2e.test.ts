/**
 * End-to-end test of the on-chain roles against a local anvil, run by apps/workers/e2e/onchain-e2e.sh (skipped without
 * VELUM_E2E_RPC). The script starts anvil, a scratch Postgres and Redis, deploys the contracts with forge script and
 * builds apps/workers. This file then runs the indexer in-process (startOnchain, on BullMQ, as the workers do) and the
 * price relayer and keeper as the real, separate signer process (`node dist/signer.js`, on-chain audit M-2): its own
 * keys file, state directory and status file, no DATABASE_URL, no REDIS_URL, its quotes from a fake Robinhood API on
 * 127.0.0.1 (the test-only SIGNER_TEST_* settings, honoured on anvil only), its positions from the chain. It checks:
 *  1. the ABIs in packages/config match the forge artifacts;
 *  2. the signer pushes its own Robinhood quote (once confirmed by a change), never a market it has no quote for;
 *  3. positions open, the price falls (anvil time warps let the rate limit walk it), the keeper liquidates the
 *     5x long, the indexer records it (position, trade, activity), and no log line ever holds a hot key;
 *  4. a push stuck in the mempool is replaced with bumped fees and fresh prices, and the replacement mines (seen from
 *     outside the signer, in anvil's transaction pool);
 *  5. a reorg (anvil snapshot / revert) rewinds the index to the common ancestor;
 *  6. a forced exit matures (7-day warp) and the keeper settles it;
 *  7. /v1/health's on-chain summary combines the workers' status and the signer's status file.
 * It writes what the API test needs (apps/api/src/onchain-e2e.test.ts) to VELUM_E2E_OUT.
 * Only anvil's public test accounts sign, with keys derived from anvil's public test mnemonic.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAINNET_CHAIN_ID, MAINNET_TOKEN_ADDRESSES, parseRedisUrl } from '@velum/config';
import { createCacheMac } from '@velum/config/src/cache-mac';
import { readDeploymentFile } from '@velum/config/src/deployment-file';
import { ONCHAIN_STATUS_KEY, parseOnchainStatus, parseSignerStatus, type Deployment, type SignerStatus } from '@velum/config/src/onchain';
import { PrismaClient } from '@velum/db';
import { Redis } from 'ioredis';
import {
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  http,
  parseAbi,
  parseEventLogs,
  toEventSelector,
  toFunctionSelector,
  toHex,
  type AbiEvent,
  type AbiFunction,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onchainSummary } from '../../../api/src/routes/health';
import type { Logger } from '../lib/log';
import { abis, chainFor, publicClientFor } from './chain';
import { loadOnchainEnv } from './env';
import { startOnchain, type OnchainHandle } from './index';
import { PUSH_EXEC_GAS_BASE, PUSH_EXEC_GAS_PER_MARKET } from './relayer';
import { bump } from './tx-sender';

const RPC = process.env.VELUM_E2E_RPC;
const DIR = process.env.VELUM_E2E_DEPLOYMENTS ?? '';
const ARTIFACTS = process.env.VELUM_E2E_ARTIFACTS ?? '';
const OUT = process.env.VELUM_E2E_OUT ?? '';
const DB = process.env.TEST_DATABASE_URL ?? '';
const REDIS = process.env.TEST_REDIS_URL ?? '';
const CHAIN_ID = 31337;
/** anvil's public test mnemonic (its default accounts). */
const MNEMONIC = 'test test test test test test test test test test test junk';
const keyOf = (i: number): Hex => toHex(mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey!);
const MOCK_ABI = parseAbi(['function mint(address to, uint256 amount)', 'function approve(address spender, uint256 amount) returns (bool)']);
const E6 = 1_000_000n;
const E18 = 10n ** 18n;
const MAX = 2n ** 256n - 1n;
// Monday 2026-11-16 10:00 US Eastern: the session calendar is open on the injected clock.
const OPEN = Date.UTC(2026, 10, 16, 15, 0, 0);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SIGNER_JS = path.resolve(__dirname, '../../dist/signer.js');
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, everyMs = 500): Promise<T> {
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

/** A logger that keeps every line (to check no hot key is ever logged) and prints warnings and errors. */
function captureLogger(lines: string[]): Logger {
  const write = (level: string) => (msg: string, data?: Record<string, unknown>) => {
    const line = JSON.stringify({ level, msg, ...data });
    lines.push(line);
    if (level === 'warn' || level === 'error') process.stderr.write(`${line}\n`);
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

describe.skipIf(!RPC)('on-chain workers end to end (anvil)', () => {
  let d: Deployment;
  let prisma: PrismaClient;
  let redis: Redis;
  let client: PublicClient;
  let handle: OnchainHandle;
  const lines: string[] = [];
  const t0 = Date.now();
  const clock = () => OPEN + (Date.now() - t0);
  // The fake Robinhood API's quotes. TSLA starts one cent lower: the signer confirms a quote only once it has seen it
  // change (audit F-6), so its first push is the quote it moved to. AMZN has no quote at all.
  const target: Record<string, string> = { TSLA: '391.64' };
  let quoteServer: Server | undefined;
  let signer: ChildProcess | undefined;
  const signerOut: string[] = [];
  let home = '';
  const relayKey = keyOf(1);
  const keeperKey = keyOf(2);
  const keeper = mnemonicToAccount(MNEMONIC, { addressIndex: 2 }).address;
  const makerAcc = mnemonicToAccount(MNEMONIC, { addressIndex: 3 });
  const takerAcc = mnemonicToAccount(MNEMONIC, { addressIndex: 4 });
  const taker2Acc = mnemonicToAccount(MNEMONIC, { addressIndex: 5 });
  const result: Record<string, unknown> = {};

  const wallet = (account: typeof makerAcc) => createWalletClient({ account, chain: chainFor(CHAIN_ID, RPC!), transport: http(RPC!) });
  async function send(account: typeof makerAcc, to: Address, data: Hex, value = 0n): Promise<{ hash: Hex; block: bigint }> {
    const hash = await wallet(account).sendTransaction({ to, data, value, chain: chainFor(CHAIN_ID, RPC!) });
    const r = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (r.status !== 'success') throw new Error(`transaction reverted: ${hash}`);
    return { hash, block: r.blockNumber };
  }
  const call = (abi: readonly unknown[], functionName: string, args: readonly unknown[]): Hex =>
    (encodeFunctionData as (p: { abi: unknown; functionName: string; args: readonly unknown[] }) => Hex)({ abi, functionName, args });
  const blockTime = async () => (await client.getBlock({ blockTag: 'latest' })).timestamp;
  const relayed = async (sym: string) => (await client.readContract({ address: d.contracts.oracle, abi: abis.oracle, functionName: 'relayed', args: [d.tokens[sym]!] })) as readonly [bigint, bigint, bigint];
  const band = async (sym: string) => (await client.readContract({ address: d.contracts.oracle, abi: abis.oracle, functionName: 'bands', args: [d.tokens[sym]!] })) as readonly [bigint, bigint, bigint];
  const position = (id: bigint) => prisma.perpPosition.findUnique({ where: { chainId_perps_positionId: { chainId: CHAIN_ID, perps: d.contracts.perpsMarkets, positionId: id } } });

  /** The signer's status file (written every 5 s by the signer process). */
  const status = (): SignerStatus => {
    const s = parseSignerStatus(readFileSync(path.join(home, 'run', 'status.json'), 'utf8'), Date.now());
    if (!s) throw new Error('no signer status');
    return s;
  };
  const freshStatus = async (): Promise<SignerStatus> => {
    const before = Date.now();
    return waitFor('a fresh signer status', async () => {
      const s = status();
      return s.at >= before ? s : null;
    }, 20_000, 200);
  };

  /** A fake of api.robinhood.com/rhj/prices/<SYM>: the token's own bid/ask, dated with the signer's (shifted) clock. */
  function startQuotes(): Promise<number> {
    quoteServer = createServer((req, res) => {
      const sym = decodeURIComponent((req.url ?? '').split('/').pop() ?? '');
      const price = target[sym];
      if (!req.url?.startsWith('/prices/') || !price) {
        res.statusCode = 404;
        return res.end('{}');
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          quotes: [{ tokenSymbol: sym, deployments: [{ chainId: MAINNET_CHAIN_ID, contractAddress: MAINNET_TOKEN_ADDRESSES[sym] }], tokenBid: price, tokenAsk: price, isTradingHalt: false, generatedAt: new Date(clock()).toISOString() }],
        }),
      );
    });
    return new Promise((resolve) => quoteServer!.listen(0, '127.0.0.1', () => resolve((quoteServer!.address() as { port: number }).port)));
  }

  /** Starts `node dist/signer.js` as the separate signer process, with only the signer's settings (no Postgres, no Redis). */
  function startSigner(port: number): void {
    mkdirSync(path.join(home, 'run'), { recursive: true });
    const keys = path.join(home, 'signer-keys.env');
    writeFileSync(keys, `PRICE_RELAY_PRIVATE_KEY=${relayKey}\nKEEPER_PRIVATE_KEY=${keeperKey}\n`, { mode: 0o600 });
    chmodSync(keys, 0o600);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      NODE_ENV: 'production',
      LOG_LEVEL: 'debug',
      CHAIN_ID: String(CHAIN_ID),
      RPC_URL: RPC,
      ONCHAIN_WORKERS: 'true',
      CONFIRMATIONS: '1',
      KEEPER_INTERVAL_MS: '1000',
      PRICE_PUSH_INTERVAL_MS: '8000',
      FUNDING_EPOCH_SECONDS: '60',
      RELAYER_MAX_GWEI: '5',
      KEEPER_ETH_PRICE_USD: '100',
      SIGNER_KEYS_FILE: keys,
      SIGNER_STATUS_FILE: path.join(home, 'run', 'status.json'),
      SIGNER_STATE_DIR: path.join(home, 'state'),
      SIGNER_DEPLOYMENTS_DIR: DIR,
      SIGNER_TEST_PRICES_URL: `http://127.0.0.1:${port}/prices`,
      SIGNER_TEST_ASSETS_URL: `http://127.0.0.1:${port}/assets`,
      SIGNER_TEST_CLOCK_OFFSET_MS: String(OPEN - t0),
    };
    signer = spawn(process.execPath, ['--enable-source-maps', SIGNER_JS], { cwd: path.dirname(path.dirname(SIGNER_JS)), env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [signer.stdout!, signer.stderr!]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        signerOut.push(chunk);
        for (const l of chunk.split('\n')) if (/"level":"(warn|error)"/.test(l) && !/robinhood quote failed/.test(l)) process.stderr.write(`signer: ${l}\n`);
      });
    }
  }

  beforeAll(async () => {
    if (!existsSync(SIGNER_JS)) throw new Error(`${SIGNER_JS} is missing: build apps/workers first (onchain-e2e.sh does)`);
    const read = readDeploymentFile(DIR, CHAIN_ID);
    if (read.status !== 'ok') throw new Error(`deployment file: ${read.status}`);
    d = read.deployment;
    prisma = new PrismaClient({ datasources: { db: { url: DB } } });
    // A unix socket, like Velum's own Redis: the on-chain workers refuse any other (audit M-3).
    const parsed = parseRedisUrl(REDIS);
    if (!parsed.ok) throw new Error(parsed.error);
    redis = new Redis({ ...parsed.options, maxRetriesPerRequest: null });
    await redis.flushdb();
    client = publicClientFor(CHAIN_ID, RPC!);
    home = mkdtempSync(path.join(tmpdir(), 'velum-signer-e2e-'));
    chmodSync(home, 0o700);
    startSigner(await startQuotes());
    // The quote moves after a few polls: from then on it is confirmed (and stays so while unchanged).
    setTimeout(() => (target.TSLA = '391.65'), 5000).unref();
  }, 60_000);

  afterAll(async () => {
    await handle?.writeStatus();
    await handle?.stop();
    if (signer && signer.exitCode === null) {
      signer.kill('SIGTERM');
      await new Promise((r) => signer!.once('exit', r));
    }
    quoteServer?.close();
    lines.push(...signerOut.join('').split('\n').filter(Boolean));
    // The API's end-to-end test reads the signer's last status (as the API reads the status file in production).
    if (OUT && home && existsSync(path.join(home, 'run', 'status.json'))) writeFileSync(`${OUT}.signer-status.json`, readFileSync(path.join(home, 'run', 'status.json')));
    if (OUT) {
      writeFileSync(OUT, JSON.stringify(result, null, 2));
      writeFileSync(`${OUT}.workers.log`, lines.join('\n'));
    }
    if (home) rmSync(home, { recursive: true, force: true });
    await prisma?.$disconnect();
    await redis?.quit();
  }, 60_000);

  it('the ABIs in packages/config match the forge artifacts', () => {
    const names: Record<string, string> = { vault: 'VelumVault', oracle: 'OracleAdapter', spotPools: 'SpotPools', makerBook: 'MakerBook', perpsMarkets: 'PerpsMarkets' };
    expect(readdirSync(ARTIFACTS).length).toBeGreaterThan(0);
    for (const [key, contract] of Object.entries(names)) {
      const artifact = JSON.parse(readFileSync(path.join(ARTIFACTS, `${contract}.sol`, `${contract}.json`), 'utf8')) as { abi: Array<AbiEvent | AbiFunction | { type: string }> };
      const theirs = artifact.abi.filter((x): x is AbiEvent => x.type === 'event').map((e) => toEventSelector(e)).sort();
      const ours = (abis[key as keyof typeof abis] as readonly { type: string }[]).filter((x): x is AbiEvent => x.type === 'event').map((e) => toEventSelector(e)).sort();
      expect(ours, `${contract} events`).toEqual(theirs);
      const fns = new Set(artifact.abi.filter((x): x is AbiFunction => x.type === 'function').map((f) => toFunctionSelector(f)));
      for (const f of (abis[key as keyof typeof abis] as readonly { type: string }[]).filter((x): x is AbiFunction => x.type === 'function')) {
        expect(fns.has(toFunctionSelector(f)), `${contract}.${f.name}`).toBe(true);
      }
    }
  });

  it('the workers run the indexer only; the separate signer process pushes its own Robinhood quote, nothing it has no quote for', async () => {
    const env = loadOnchainEnv({ ONCHAIN_WORKERS: 'true', DEPLOYMENTS_DIR: DIR, CONFIRMATIONS: '1', INDEXER_POLL_MS: '500' });
    const started = await startOnchain({ env, chainId: CHAIN_ID, rpcUrl: RPC!, prisma, redis, mac: createCacheMac(DB, 'testnet'), log: captureLogger(lines), now: clock });
    expect(started).not.toBeNull();
    handle = started!;
    expect(handle.status().relayer.enabled).toBe(false);
    expect(handle.status().keeper.enabled).toBe(false);
    const [price, at] = await waitFor('the first TSLA push', async () => {
      const r = await relayed('TSLA');
      return r[1] > 0n ? r : null;
    }, 90_000);
    // Its first push is the quote it confirmed by seeing it change (never the first, unconfirmed one).
    expect(price).toBe(39165n * 10n ** 16n);
    expect(at).toBeGreaterThan(0n);
    expect((await relayed('AMZN'))[1]).toBe(0n);
    const st = await freshStatus();
    expect(st).toMatchObject({ requested: true, error: null, deployment: d.contracts.perpsMarkets });
    expect(st.relayer.markets.AMZN).toBe('no-snapshot');
    expect(st.prices.markets).toMatchObject({ TSLA: 'live', AMZN: 'none' });
    expect(st.relayer.sending).toBe(true);
    expect(st.relayer.address?.toLowerCase()).toBe(mnemonicToAccount(MNEMONIC, { addressIndex: 1 }).address.toLowerCase());
    expect(statSync(path.join(home, 'run', 'status.json')).mode & 0o777).toBe(0o640);
    expect(statSync(path.join(home, 'state')).mode & 0o777).toBe(0o700);
    // The push gas limit (estimated calldata part + 25%, plus the execution bound, audit L-4) leaves room over what a
    // push uses, and the execution bound alone covers the push's execution.
    const tx = await waitFor('the push receipt', async () => status().relayer.lastTx);
    const [receipt, sent] = await Promise.all([client.getTransactionReceipt({ hash: tx as Hex }), client.getTransaction({ hash: tx as Hex })]);
    const used = receipt.gasUsed;
    const intrinsic = await client.estimateGas({ account: sent.from, to: sent.from, data: sent.input });
    expect(used - intrinsic).toBeLessThan(((PUSH_EXEC_GAS_BASE + PUSH_EXEC_GAS_PER_MARKET) * 3n) / 4n);
    expect(sent.gas).toBe((intrinsic * 125n) / 100n + PUSH_EXEC_GAS_BASE + PUSH_EXEC_GAS_PER_MARKET);
    // The observation time it carried is its source timestamp: at least a second (the margin) and at most
    // MAX_PUSH_DELAY before its block (audit M-1).
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const ev = parseEventLogs({ abi: abis.oracle, logs: receipt.logs, eventName: 'PriceRelayed' })[0]!;
    expect(ev.args.timestamp).toBe(block.timestamp);
    expect(block.timestamp - ev.args.observedAt).toBeLessThanOrEqual(10n);
    expect(block.timestamp - ev.args.observedAt).toBeGreaterThanOrEqual(1n);
    expect(ev.args.observedAt).toBeGreaterThanOrEqual(at);
    result.pushGasUsed = used.toString();
  }, 90_000);

  it('opens positions; when the price falls the keeper liquidates the 5x long and the indexer records it', async () => {
    const { vault, perpsMarkets: perps, makerBook: book, spotPools: pools } = d.contracts;
    const usdg = d.tokens.USDG!;
    const tsla = d.tokens.TSLA!;
    for (const [acc, amount] of [
      [makerAcc, 100_000n * E6],
      [takerAcc, 10_000n * E6],
      [taker2Acc, 5_000n * E6],
    ] as const) {
      await send(acc, usdg, call(MOCK_ABI, 'mint', [acc.address, amount]));
      await send(acc, usdg, call(MOCK_ABI, 'approve', [vault, MAX]));
      await send(acc, vault, call(abis.vault, 'deposit', [usdg, amount / 2n, acc.address]));
      for (const m of [perps, pools]) await send(acc, vault, call(abis.vault, 'setApproval', [m, true]));
    }
    await send(makerAcc, vault, call(abis.vault, 'setApproval', [book, true]));
    await send(makerAcc, tsla, call(MOCK_ABI, 'mint', [makerAcc.address, 20n * E18]));
    await send(makerAcc, tsla, call(MOCK_ABI, 'approve', [vault, MAX]));
    await send(makerAcc, vault, call(abis.vault, 'deposit', [tsla, 10n * E18, makerAcc.address]));
    const now = await blockTime();
    await send(makerAcc, book, call(abis.makerBook, 'postOffer', [tsla, 10_000n * E6, 5_000n * E6, 10, 10, now + 90n * 86_400n]));
    await send(makerAcc, pools, call(abis.spotPools, 'addLiquidity', [tsla, 10n * E18, 3916n * E6, 1n, now + 3600n]));
    const swap = await send(takerAcc, pools, call(abis.spotPools, 'swap', [usdg, tsla, 100n * E6, 1n, now + 3600n]));
    result.swapTx = swap.hash;

    // Opens need a price at most 10 s old and not lagging: retry until one lands right after a push.
    const open = async (acc: typeof takerAcc, size: bigint, levHalf: number) =>
      waitFor(`open by ${acc.address}`, async () => {
        const data = call(abis.perpsMarkets, 'open', [1n, tsla, true, size, levHalf, 400n * E18]);
        await client.call({ account: acc.address, to: perps, data });
        return send(acc, perps, data);
      }, 60_000, 700);
    const o1 = await open(takerAcc, 1000n * E6, 10);
    await open(taker2Acc, 500n * E6, 4);
    result.openTx = o1.hash;
    await waitFor('both positions indexed', async () => (await position(2n)) && (await position(1n)));
    const p1 = (await position(1n))!;
    expect(p1.status).toBe('open');
    expect(p1.taker).toBe(takerAcc.address.toLowerCase());
    expect(p1.offerId).toBe(1n);
    expect(p1.size?.toFixed()).toBe((1000n * E6).toString());

    // A 12% fall. Each 300 s warp gives the next push the full 5% allowance (relay-math: a jump that
    // cannot fit before the gap limit is pushed to converge, so the market walks down at the rate limit).
    target.TSLA = '344.65';
    for (let i = 0; i < 4; i++) {
      const [, last] = await relayed('TSLA');
      await rpc('evm_increaseTime', [300]);
      await rpc('evm_mine');
      await waitFor('a push after the warp', async () => (await relayed('TSLA'))[1] > last, 60_000);
      if ((await band('TSLA'))[0] <= 34465n * 10n ** 16n) break;
    }
    expect((await band('TSLA'))[0]).toBe(34465n * 10n ** 16n);
    // The relayer reads the receipt of its last push on its next tick (and reports it within 5 s).
    await waitFor('the relayer to see its push land exactly', async () => status().relayer.markets.TSLA === 'pushed', 30_000, 500);

    const liquidated = await waitFor('the keeper liquidates position 1', async () => {
      const p = await position(1n);
      return p?.status === 'liquidated' && p.exitPrice !== null ? p : null;
    }, 90_000);
    expect(liquidated.liquidator).toBe(keeper.toLowerCase());
    expect(liquidated.liquidatedSide).toBe('taker');
    expect(BigInt(liquidated.reward!.toFixed())).toBeGreaterThan(0n);
    const onChain = (await client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'getPosition', args: [1n] })) as { open: boolean };
    expect(onChain.open).toBe(false);
    const trades = await prisma.perpTrade.findMany({ where: { chainId: CHAIN_ID, positionId: 1n }, orderBy: { block: 'asc' } });
    expect(trades.map((t) => t.kind)).toEqual(['open', 'liquidation']);
    const kinds = (await prisma.accountActivity.findMany({ where: { chainId: CHAIN_ID, account: takerAcc.address.toLowerCase() } })).map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['deposit', 'swap', 'position_open', 'position_liquidate', 'position_settled']));
    expect(await prisma.accountActivity.count({ where: { chainId: CHAIN_ID, account: keeper.toLowerCase(), kind: 'liquidation_reward' } })).toBe(1);
    expect(await prisma.fundingPoint.count({ where: { chainId: CHAIN_ID, market: tsla } })).toBeGreaterThan(0);
    expect(await prisma.spotPoolState.count({ where: { chainId: CHAIN_ID, stock: tsla } })).toBe(1);
    // The keeper found position 1 on the chain itself (the signer has no database).
    await waitFor('the keeper to report it', async () => status().keeper.liquidations === 1, 15_000, 500);
    Object.assign(result, { liquidatedId: '1', liquidateTx: liquidated.closeTx });
  }, 300_000);

  it('replaces a push stuck in the mempool with bumped fees, and the replacement mines', async () => {
    const relayAddr = mnemonicToAccount(MNEMONIC, { addressIndex: 1 }).address.toLowerCase();
    type PoolTx = { hash: Hex; nonce: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex; input: Hex };
    /** The relay key's transactions in anvil's pool (the signer is another process: its pool entries are what we see). */
    const pooled = async (): Promise<PoolTx[]> => {
      const pool = await rpc<{ pending: Record<string, Record<string, PoolTx>> }>('txpool_content');
      const mine = Object.entries(pool.pending).find(([a]) => a.toLowerCase() === relayAddr)?.[1] ?? {};
      return Object.values(mine);
    };
    await rpc('evm_setAutomine', [false]);
    try {
      // Without mining the block time stands still: one block 10 s later makes the next push due.
      await rpc('evm_increaseTime', [10]);
      await rpc('evm_mine');
      const first = await waitFor('a pending push', async () => (await pooled())[0] ?? null, 30_000, 200);
      expect(decodeFunctionData({ abi: abis.oracle, data: first.input }).functionName).toBe('pushPrices');
      // Not mined after 6 s: replaced at the same nonce (anvil drops the replaced one from its pool).
      const repl = await waitFor('its replacement', async () => {
        const p = (await pooled()).find((t) => t.nonce === first.nonce);
        return p && p.hash !== first.hash ? p : null;
      }, 30_000, 200);
      // The replacement carries the prices of the moment (a fresh push), not a cancellation, with bumped fees.
      expect(decodeFunctionData({ abi: abis.oracle, data: repl.input }).functionName).toBe('pushPrices');
      expect(BigInt(repl.maxFeePerGas) >= bump(BigInt(first.maxFeePerGas))).toBe(true);
      expect(BigInt(repl.maxPriorityFeePerGas) >= bump(BigInt(first.maxPriorityFeePerGas))).toBe(true);
      // Mine the newest version in the pool (the signer may have replaced it again meanwhile).
      await rpc('evm_mine');
      const minedHash = await waitFor('a version mined', async () => {
        for (const h of [repl.hash, first.hash]) if (await client.getTransactionReceipt({ hash: h }).catch(() => null)) return h;
        const n = await client.getTransactionCount({ address: relayAddr as Address, blockTag: 'latest' });
        return n > Number(BigInt(first.nonce)) ? ('other' as Hex) : null;
      }, 30_000);
      expect(minedHash).not.toBe(first.hash);
      await expect(client.getTransactionReceipt({ hash: first.hash })).rejects.toThrow();
      result.replacement = { nonce: Number(BigInt(first.nonce)), original: first.hash, replacement: repl.hash };
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
  }, 120_000);

  it('rewinds the index to the common ancestor after a reorg (snapshot and revert), refolding touched state', async () => {
    const { vault, makerBook: book, perpsMarkets: perps } = d.contracts;
    const usdg = d.tokens.USDG!;
    const before = (await position(2n))!;
    const offer = (id: bigint) => prisma.makerOffer.findUnique({ where: { chainId_book_offerId: { chainId: CHAIN_ID, book, offerId: id } } });
    const offer1 = (await offer(1n))!;
    const snap = await rpc<string>('evm_snapshot');
    // The orphaned branch: a deposit, a new offer and more margin on position 2 (state rows above the ancestor).
    const gone = await send(takerAcc, vault, call(abis.vault, 'deposit', [usdg, 7n * E6, takerAcc.address]));
    await send(makerAcc, book, call(abis.makerBook, 'postOffer', [d.tokens.TSLA!, 1_000n * E6, 500n * E6, 20, 20, (await blockTime()) + 86_400n]));
    await send(taker2Acc, perps, call(abis.perpsMarkets, 'addMargin', [2n, 25n * E6]));
    for (let i = 0; i < 3; i++) await rpc('evm_mine');
    await waitFor('the orphaned branch indexed', async () => {
      const [t, o, p] = await Promise.all([prisma.vaultTransfer.findFirst({ where: { chainId: CHAIN_ID, txHash: gone.hash } }), offer(2n), position(2n)]);
      return t && o && p && p.takerMargin.toFixed() === (before.takerMargin.toNumber() + 25e6).toFixed() ? true : null;
    });
    const reorgsBefore = handle.indexer.status().reorgs;
    expect(await rpc<boolean>('evm_revert', [snap])).toBe(true);
    const kept = await send(takerAcc, vault, call(abis.vault, 'deposit', [usdg, 9n * E6, takerAcc.address]));
    for (let i = 0; i < 5; i++) await rpc('evm_mine');
    await waitFor('the orphaned rows removed and the new deposit indexed', async () => {
      const [a, b, o] = await Promise.all([prisma.vaultTransfer.findFirst({ where: { chainId: CHAIN_ID, txHash: gone.hash } }), prisma.vaultTransfer.findFirst({ where: { chainId: CHAIN_ID, txHash: kept.hash } }), offer(2n)]);
      return !a && b && !o ? b : null;
    }, 60_000);
    expect(handle.indexer.status().reorgs).toBeGreaterThan(reorgsBefore);
    expect(await prisma.chainEvent.count({ where: { txHash: gone.hash } })).toBe(0);
    expect(await prisma.accountActivity.count({ where: { txHash: gone.hash } })).toBe(0);
    const cp = await prisma.indexerCheckpoint.findUniqueOrThrow({ where: { chainId_deployment: { chainId: CHAIN_ID, deployment: perps } } });
    expect((await client.getBlock({ blockNumber: cp.block })).hash).toBe(cp.blockHash);
    // Position 2 was refolded from the events below the ancestor: its margin is back, nothing else changed.
    const after = (await position(2n))!;
    expect(after.takerMargin.toFixed()).toBe(before.takerMargin.toFixed());
    expect({ ...after, lastBlock: 0n, lastLogIndex: 0 }).toEqual({ ...before, lastBlock: 0n, lastLogIndex: 0 });
    expect(after.lastBlock).toBe(before.lastBlock);
    expect(await offer(1n)).toEqual(offer1);
    expect((await position(1n))?.status).toBe('liquidated');
    result.depositTx = kept.hash;
  }, 120_000);

  it('advances funding for a market with open interest once its funding is older than the epoch', async () => {
    const before = (await freshStatus()).keeper.fundingAdvances;
    const points = await prisma.fundingPoint.count({ where: { chainId: CHAIN_ID } });
    await rpc('evm_increaseTime', [120]); // FUNDING_EPOCH_SECONDS is 60 here; position 2 is open
    await rpc('evm_mine');
    await waitFor('the keeper advances funding', async () => status().keeper.fundingAdvances > before, 90_000, 500);
    await waitFor('the FundingAdvanced event indexed', async () => (await prisma.fundingPoint.count({ where: { chainId: CHAIN_ID } })) > points);
  }, 120_000);

  it('settles a matured forced exit (7 days) as the keeper', async () => {
    const perps = d.contracts.perpsMarkets;
    await send(makerAcc, perps, call(abis.perpsMarkets, 'requestForcedExit', [2n]), 10n ** 15n);
    await waitFor('the request indexed', async () => (await position(2n))?.exitRequester ?? null);
    await rpc('evm_increaseTime', [7 * 86_400 + 60]);
    await rpc('evm_mine');
    const p = await waitFor('the keeper settles the forced exit', async () => {
      const row = await position(2n);
      return row?.status === 'forced_exit' && row.exitPrice !== null ? row : null;
    }, 120_000);
    expect(p.exitRequester).toBe(makerAcc.address.toLowerCase());
    expect(p.exitAtEntry).toBe(false);
    // The keeper saw the request and its maturity on the chain (getPosition's exitRequestedAt), not in the index.
    await waitFor('the keeper to report it', async () => status().keeper.forcedExits === 1, 15_000, 500);
    Object.assign(result, {
      chainId: CHAIN_ID,
      deploymentsDir: DIR,
      taker: takerAcc.address,
      taker2: taker2Acc.address,
      maker: makerAcc.address,
      keeper,
      relayer: status().relayer.address,
      forcedExitId: '2',
    });
  }, 180_000);

  it("/v1/health combines the workers' status (indexer) and the signer's status file (relayer, keeper)", async () => {
    await handle.writeStatus();
    const workers = parseOnchainStatus(createCacheMac(DB, 'testnet').open(ONCHAIN_STATUS_KEY, await redis.get(ONCHAIN_STATUS_KEY), 16 * 1024), Date.now());
    expect(workers?.relayer.enabled).toBe(false);
    const s = onchainSummary(workers, Date.now(), () => false, await freshStatus())!;
    expect(s.reasons).toEqual([]);
    expect(s).toMatchObject({ ok: true, relayer: { enabled: true, sending: true }, keeper: { enabled: true, liquidations: 1, forcedExits: 1 }, indexer: { error: null } });
    expect(s.signerAge).toBeLessThanOrEqual(6);
    // Without the signer's status the summary says so.
    expect(onchainSummary(workers, Date.now(), () => false, null)!.reasons).toEqual([expect.stringMatching(/^signer: no status from velum-signer/)]);
  });

  it('never logged a hot key (the workers and the signer process)', () => {
    const all = `${lines.join('\n')}\n${signerOut.join('')}`.toLowerCase();
    for (const k of [relayKey, keeperKey]) expect(all).not.toContain(k.slice(2).toLowerCase());
    expect(signerOut.join('')).toMatch(/signer started/);
    expect(lines.length).toBeGreaterThan(0);
  });
});
