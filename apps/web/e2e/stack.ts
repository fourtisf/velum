/**
 * The local back end of the web's on-chain end-to-end test (apps/web/e2e/onchain-e2e.sh), in one process:
 *  - the API built from this tree (apps/api buildApp, as apps/api/src/server.ts wires it), serving
 *    /v1/deployment, positions and activity for the anvil deployment (chain 31337);
 *  - the on-chain indexer from apps/workers (startOnchain without hot keys: indexer only);
 *  - market snapshots in Redis (authenticated like the workers write them) so /v1/markets has prices;
 *  - a price pusher (the deployment's relay account on anvil) every 2 s, each push carrying its observation time
 *    (OracleAdapter.pushPrices(tokens, prices, observedAt), on-chain audit M-1: the chain time of a fresh block, so it is
 *    never in the future, at most a few seconds old when it lands, and newer than the last one);
 *  - seed liquidity and maker offers from anvil's public test accounts;
 *  - a control port for the browser test: set a price, warp time, fund or allowlist a throwaway wallet.
 * Only anvil's public test accounts and throwaway keys sign. Nothing here talks to a public network.
 *
 * Env: E2E_RPC, E2E_DEPLOYMENTS (dir with 31337.json), DATABASE_URL, REDIS_URL, E2E_API_PORT, E2E_CTL_PORT,
 * E2E_GUARD_ADMIN (the guarded deployment's admin, an anvil account) and PROXY_SECRET.
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { foundry } from 'viem/chains';

const here = __dirname;
const root = path.resolve(here, '../../..');
const fromApi = createRequire(path.join(root, 'apps/api/package.json'));
const fromWorkers = createRequire(path.join(root, 'apps/workers/package.json'));

const RPC = process.env.E2E_RPC!;
const DIR = process.env.E2E_DEPLOYMENTS!;
const DB = process.env.DATABASE_URL!;
const REDIS = process.env.REDIS_URL!;
const API_PORT = Number(process.env.E2E_API_PORT ?? 4791);
const CTL_PORT = Number(process.env.E2E_CTL_PORT ?? 4792);
const CHAIN_ID = 31337;
const E6 = 1_000_000n;
const E18 = 10n ** 18n;
/** anvil's default accounts (public test keys, unlocked in anvil): 0 deployer, 1 relayer, 3 maker. */
const ACC = {
  deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  relayer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  maker: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
} as const satisfies Record<string, Address>;

const MOCK = parseAbi(['function mint(address to, uint256 amount)', 'function approve(address spender, uint256 amount) returns (bool)']);
const VAULT = parseAbi(['function deposit(address token, uint256 amount, address to) returns (uint256)', 'function setApproval(address module, bool ok)', 'function addToAllowlist(address[] accounts)']);
const ORACLE = parseAbi([
  'function pushPrices(address[] tokens, uint256[] prices, uint256 observedAt)',
  'function relayed(address token) view returns (uint128 price, uint64 updatedAt, uint64 pushedAt)',
  'function latest(address token) view returns (uint256 p, uint256 updatedAt)',
  'function lagging(address token) view returns (bool)',
]);
const SPOT = parseAbi(['function addLiquidity(address stock, uint256 maxStock, uint256 maxUsdg, uint256 minShares, uint256 deadline) returns (uint256, uint256, uint256)']);
const BOOK = parseAbi(['function postOffer(address market, uint256 backing, uint256 largestFill, uint16 openSpreadBps, uint16 closeSpreadBps, uint64 expiry) returns (uint256)']);

const chain = { ...foundry, id: CHAIN_ID, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (account: Address) => createWalletClient({ account, chain, transport: http(RPC) });

async function send(from: Address, to: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<Hex> {
  const hash = await wallet(from).writeContract({ address: to, abi: abi as never, functionName: functionName as never, args: args as never, chain } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
  return hash;
}

const rpc = async (method: string, params: unknown[] = []) => {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};

async function main() {
  const { readDeploymentFile } = fromWorkers('@velum/config/src/deployment-file') as typeof import('../../../packages/config/src/deployment-file');
  const read = readDeploymentFile(DIR, CHAIN_ID);
  if (read.status !== 'ok') throw new Error(`deployment file: ${read.status}`);
  const d = read.deployment;
  const raw = JSON.parse((await import('node:fs')).readFileSync(path.join(DIR, `${CHAIN_ID}.json`), 'utf8')) as { guardAdmin?: string };
  const guardAdmin = raw.guardAdmin && !/^0x0{40}$/i.test(raw.guardAdmin) ? (raw.guardAdmin as Address) : null;
  const t = d.tokens as Record<string, Address>;
  const c = d.contracts as Record<string, Address>;
  const target: Record<string, bigint> = { TSLA: 39165n * 10n ** 16n, AMZN: 23340n * 10n ** 16n };

  // ---- prices: pushed on chain every 2 s, and authenticated snapshots for /v1/markets every second.
  // Pushes run one at a time (the timer and /warp share them). Each carries the chain's current time as its
  // observation time: an empty block is mined first (anvil only mines on demand, so the latest block can be
  // minutes old, and a push more than 10 s after its observation is refused) and its time is used. The
  // contract also wants it newer than the last observation and the push in a later second than the last push
  // (anvil can mine several blocks in one second), so when the chain has not moved on yet the next block is
  // dated one second later.
  let queue: Promise<void> = Promise.resolve();
  const pushNow = async () => {
    const syms = Object.keys(target).filter((s) => t[s]);
    await rpc('evm_mine');
    const [block, ...rel] = await Promise.all([pub.getBlock({ blockTag: 'latest' }), ...syms.map((s) => pub.readContract({ address: c.oracle, abi: ORACLE, functionName: 'relayed', args: [t[s]!] }))]);
    const need = rel.reduce((m, [, updatedAt, pushedAt]) => [m, updatedAt + 1n, pushedAt + 1n].reduce((a, b) => (a > b ? a : b)), 0n);
    let observedAt = block.timestamp;
    if (observedAt < need) {
      observedAt = need;
      await rpc('evm_setNextBlockTimestamp', [Number(need)]);
    }
    await send(ACC.relayer, c.oracle, ORACLE, 'pushPrices', [syms.map((s) => t[s]), syms.map((s) => target[s]), observedAt]);
  };
  const push = (): Promise<void> => {
    const run = queue.then(pushNow);
    queue = run.catch(() => undefined);
    return run;
  };
  await push();
  console.log('[stack] first prices pushed');

  // ---- seed: the maker deposits, adds liquidity and posts offers (allowlisted first when guarded)
  if (guardAdmin) await send(guardAdmin, c.vault, VAULT, 'addToAllowlist', [[ACC.maker]]);
  await send(ACC.maker, t.USDG!, MOCK, 'mint', [ACC.maker, 1_000_000n * E6]);
  await send(ACC.maker, t.USDG!, MOCK, 'approve', [c.vault, 1_000_000n * E6]);
  // Within the guarded deployment's 100,000 USDG account cap (onchain-e2e.sh).
  await send(ACC.maker, c.vault, VAULT, 'deposit', [t.USDG, 90_000n * E6, ACC.maker]);
  for (const m of [c.makerBook, c.spotPools]) await send(ACC.maker, c.vault, VAULT, 'setApproval', [m, true]);
  const now = (await pub.getBlock()).timestamp;
  for (const sym of Object.keys(target)) {
    if (!t[sym]) continue;
    await send(ACC.maker, t[sym]!, MOCK, 'mint', [ACC.maker, 1000n * E18]);
    await send(ACC.maker, t[sym]!, MOCK, 'approve', [c.vault, 1000n * E18]);
    await send(ACC.maker, c.vault, VAULT, 'deposit', [t[sym], 150n * E18, ACC.maker]);
    // 100 tokens and their value in USDG at the seed price.
    await send(ACC.maker, c.spotPools, SPOT, 'addLiquidity', [t[sym], 100n * E18, (100n * target[sym]!) / 10n ** 12n, 1n, now + 3600n]);
    await send(ACC.maker, c.makerBook, BOOK, 'postOffer', [t[sym], 10_000n * E6, 5_000n * E6, 5, 5, now + 90n * 86_400n]);
  }

  console.log('[stack] liquidity and offers seeded');
  // ---- the API from this tree, for chain 31337 (loadEnv only accepts the configured network's chain id)
  const { buildApp } = fromApi('./src/app') as typeof import('../../api/src/app');
  const { loadEnv } = fromApi('./src/env') as typeof import('../../api/src/env');
  const { prismaDb, redisCache, viemChain } = fromApi('./src/lib/adapters') as typeof import('../../api/src/lib/adapters');
  const { deploymentSource, prismaOnchain } = fromApi('./src/lib/onchain') as typeof import('../../api/src/lib/onchain');
  const { createCacheMac } = fromApi('@velum/config/src/cache-mac') as typeof import('../../../packages/config/src/cache-mac');
  const { cacheKeys } = fromApi('@velum/config') as typeof import('../../../packages/config/src/index');
  const { PrismaClient } = fromApi('@velum/db') as typeof import('@velum/db');
  const { Redis } = fromApi('ioredis') as typeof import('ioredis');
  const { parseRedisUrl } = fromApi('@velum/config') as typeof import('../../../packages/config/src/index');
  // A unix socket (onchain-e2e.sh): the on-chain workers refuse any other Redis (audit M-3).
  const conn = parseRedisUrl(REDIS);
  if (!conn.ok) throw new Error(conn.error);
  const env = { ...loadEnv({ ...process.env, VELUM_NETWORK: 'testnet', CHAIN_ID: '', RPC_URL: RPC, DEPLOYMENTS_DIR: DIR, PORT_API: String(API_PORT), RATE_LIMIT_READ_PER_MIN: '5000', LOG_LEVEL: 'warn' }), chainId: CHAIN_ID };
  const prisma = new PrismaClient({ datasources: { db: { url: DB } } });
  const redis = new Redis({ ...conn.options, maxRetriesPerRequest: 1 });
  const mac = createCacheMac(DB, 'testnet');
  const app = await buildApp({
    env,
    cache: redisCache(redis, { mac }),
    db: prismaDb(prisma),
    chain: viemChain(RPC),
    deployment: deploymentSource(DIR, CHAIN_ID, 1000),
    onchain: prismaOnchain(prisma),
    rateLimitRedis: redis,
  });
  await app.listen({ host: '127.0.0.1', port: API_PORT });
  console.log(`[stack] API on 127.0.0.1:${API_PORT}`);

  const writeSnapshots = async () => {
    const at = Date.now();
    const pipe = redis.pipeline();
    for (const [symbol, p] of Object.entries(target)) {
      const price = (Number(p / 10n ** 14n) / 10_000).toFixed(2);
      const snap = { symbol, price, mark: price, open24h: price, spark: [price], source: 'robinhood', updatedAt: at, checkedAt: at };
      pipe.set(cacheKeys.price(symbol), mac.seal(cacheKeys.price(symbol), JSON.stringify(snap)));
    }
    await pipe.exec();
  };

  // ---- the indexer from apps/workers (no hot keys: no relayer, no keeper)
  const { startOnchain } = fromWorkers('./src/onchain/index') as typeof import('../../workers/src/onchain/index');
  const { loadOnchainEnv } = fromWorkers('./src/onchain/env') as typeof import('../../workers/src/onchain/env');
  const quiet = { debug: () => undefined, info: () => undefined, warn: (m: string, x?: object) => console.error('[indexer]', m, JSON.stringify(x ?? {})), error: (m: string, x?: object) => console.error('[indexer]', m, JSON.stringify(x ?? {})) };
  const bull = new Redis({ ...conn.options, maxRetriesPerRequest: null });
  const handle = await startOnchain({
    env: loadOnchainEnv({ ONCHAIN_WORKERS: 'true', DEPLOYMENTS_DIR: DIR, CONFIRMATIONS: '1', INDEXER_POLL_MS: '500' }),
    chainId: CHAIN_ID,
    rpcUrl: RPC,
    prisma: prisma as never,
    redis: bull,
    mac,
    log: quiet,
  });
  if (!handle) throw new Error('indexer did not start');

  let pushing = true;
  const timers = [
    setInterval(() => void writeSnapshots().catch((e) => console.error('[snap]', String(e))), 1000),
    setInterval(() => void (pushing ? push().catch((e) => console.error('[push]', String(e).split('\n')[0])) : undefined), 2000),
  ];

  // ---- control port for the browser test
  createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const q = (k: string) => u.searchParams.get(k) ?? '';
    const ok = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
    };
    const fail = (e: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    };
    void (async () => {
      switch (u.pathname) {
        case '/info':
          return ok({ deployment: d, guardAdmin, apiPort: API_PORT });
        case '/price': {
          const sym = q('sym');
          target[sym] = BigInt(q('wei'));
          return ok({ sym, price: target[sym] });
        }
        case '/oracle': {
          const tok = t[q('sym')]!;
          const [p, at] = await pub.readContract({ address: c.oracle, abi: ORACLE, functionName: 'latest', args: [tok] });
          const lagging = await pub.readContract({ address: c.oracle, abi: ORACLE, functionName: 'lagging', args: [tok] });
          return ok({ price: p, updatedAt: at, lagging, now: (await pub.getBlock()).timestamp });
        }
        case '/pusher':
          pushing = q('on') !== '0';
          return ok({ pushing });
        case '/warp': {
          await rpc('evm_increaseTime', [Number(q('s'))]);
          await rpc('evm_mine');
          await push();
          return ok({ warped: Number(q('s')) });
        }
        case '/fund': {
          const to = q('addr') as Address;
          await rpc('anvil_setBalance', [to, '0x' + (10n * E18).toString(16)]);
          if (q('usdg')) await send(ACC.maker, t.USDG!, MOCK, 'mint', [to, BigInt(q('usdg')) * E6]);
          for (const sym of Object.keys(target)) if (q(sym.toLowerCase())) await send(ACC.maker, t[sym]!, MOCK, 'mint', [to, BigInt(q(sym.toLowerCase())) * E18]);
          return ok({ funded: to });
        }
        case '/allowlist': {
          if (!guardAdmin) throw new Error('not a guarded deployment');
          await send(guardAdmin, c.vault, VAULT, 'addToAllowlist', [[q('addr') as Address]]);
          return ok({ allowlisted: q('addr') });
        }
        case '/indexed':
          return ok(handle.status().indexer);
        default:
          res.writeHead(404);
          res.end();
      }
    })().catch(fail);
  }).listen(CTL_PORT, '127.0.0.1');

  console.log(JSON.stringify({ ready: true, apiPort: API_PORT, ctlPort: CTL_PORT, guarded: !!guardAdmin, vault: c.vault }));
  const stop = async () => {
    // Never outlive the test: onchain-e2e.sh stops Redis and PostgreSQL right after, and a close waiting on
    // them would keep this process (and its ports) alive into the next phase.
    setTimeout(() => process.exit(0), 3000).unref();
    timers.forEach(clearInterval);
    await handle.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    redis.disconnect();
    bull.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
