/**
 * The Phase 3 endpoints over the index the workers' end-to-end test built (apps/workers/e2e/onchain-e2e.sh runs
 * this right after apps/workers/src/onchain/e2e.test.ts, against the same scratch Postgres and Redis, and the last
 * status file of the signer process it ran: on-chain audit M-2). Skipped without VELUM_E2E_OUT.
 */
import { readFileSync } from 'node:fs';
import { parseRedisUrl } from '@velum/config';
import { createCacheMac } from '@velum/config/src/cache-mac';
import { PrismaClient } from '@velum/db';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { getAddress } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import type { ApiEnv } from './env';
import { fileSigner, prismaDb, redisCache } from './lib/adapters';
import { deploymentSource, prismaOnchain, type ActivityItem, type ActivityPage, type PositionView } from './lib/onchain';

const OUT = process.env.VELUM_E2E_OUT;
const DB = process.env.TEST_DATABASE_URL ?? '';
const REDIS = process.env.TEST_REDIS_URL ?? '';

interface E2EResult {
  chainId: number;
  deploymentsDir: string;
  taker: string;
  maker: string;
  keeper: string;
  relayer: string;
  liquidatedId: string;
  forcedExitId: string;
  depositTx: string;
  swapTx: string;
}

describe.skipIf(!OUT)('Phase 3 API over the end-to-end index', () => {
  let r: E2EResult;
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let redis: Redis;

  beforeAll(async () => {
    r = JSON.parse(readFileSync(OUT!, 'utf8')) as E2EResult;
    prisma = new PrismaClient({ datasources: { db: { url: DB } } });
    // TEST_REDIS_URL is a unix socket URL: the on-chain workers only run on one (audit M-3).
    const parsed = parseRedisUrl(REDIS);
    if (!parsed.ok) throw new Error(parsed.error);
    redis = new Redis({ ...parsed.options, maxRetriesPerRequest: 1 });
    const env: ApiEnv = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: DB,
      redisUrl: REDIS,
      redis: parsed.options,
      corsOrigins: false,
      rateReadPerMin: 1000,
      rateQuotePerMin: 30,
      rateHealthPerMin: 60,
      rateMarketsPerMin: 600,
      rpcUrl: 'http://127.0.0.1:1',
      chainId: r.chainId,
      network: 'testnet',
      demoMode: true,
      logLevel: 'silent',
      proxySecret: null,
      socketPath: null,
      deploymentsDir: r.deploymentsDir,
    };
    app = await buildApp({
      env,
      cache: redisCache(redis, { mac: createCacheMac(DB, 'testnet') }),
      // The relayer and keeper report from velum-signer's status file (the workers' test kept its last one).
      signer: fileSigner(`${OUT}.signer-status.json`),
      db: prismaDb(prisma),
      chain: { blockNumber: async () => null },
      deployment: deploymentSource(r.deploymentsDir, r.chainId),
      onchain: prismaOnchain(prisma),
    });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await redis?.quit();
  });

  it('GET /v1/deployment: addresses checksummed, guard state, indexer progress', async () => {
    const res = await app.inject('/v1/deployment');
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.chainId).toBe(31337);
    expect(Object.keys(d.contracts).sort()).toEqual(['makerBook', 'oracle', 'perpsMarkets', 'spotPools', 'vault']);
    for (const a of [...Object.values(d.contracts), ...Object.values(d.tokens)] as string[]) expect(a).toBe(getAddress(a));
    expect(d.priceRelayer).toBe(r.relayer);
    expect(d.guard).toEqual({ guardian: null, closeOnly: { AMZN: false, TSLA: false } });
    expect(d.indexer.block).toBeGreaterThan(0);
  });

  it('GET /v1/accounts/:address/positions: any letter case in, checksummed out', async () => {
    const lower = await app.inject(`/v1/accounts/${r.taker.toLowerCase()}/positions`);
    const upper = await app.inject(`/v1/accounts/0x${r.taker.slice(2).toUpperCase()}/positions`);
    expect(lower.statusCode).toBe(200);
    expect(upper.json()).toEqual(lower.json());
    const positions = lower.json() as PositionView[];
    const p = positions.find((x) => x.id === r.liquidatedId)!;
    expect(p).toMatchObject({ market: 'TSLA', role: 'taker', side: 'long', status: 'liquidated', taker: r.taker, maker: r.maker, offerId: '1', size: '1000' });
    expect(p.liquidation).toMatchObject({ liquidator: r.keeper, side: 'taker' });
    expect(Number(p.liquidation!.reward)).toBeGreaterThan(0);
    expect(p.exitPrice).toBe('344.65');
    expect(p.closeTx).toMatch(/^0x[0-9a-f]{64}$/);

    const maker = (await app.inject(`/v1/accounts/${r.maker}/positions?status=closed`)).json() as PositionView[];
    const fx = maker.find((x) => x.id === r.forcedExitId)!;
    expect(fx).toMatchObject({ role: 'maker', status: 'forced_exit' });
    expect(fx.forcedExit).toMatchObject({ requester: r.maker, atEntry: false });
    expect((await app.inject(`/v1/accounts/${r.maker}/positions?status=open`)).json()).toEqual([]);
    expect((await app.inject(`/v1/accounts/0x${'1'.repeat(40)}/positions`)).json()).toEqual([]);
  });

  it('rejects malformed addresses and cursors', async () => {
    for (const bad of ['0x123', `0x${'g'.repeat(40)}`, r.taker.slice(2), `${r.taker}00`]) {
      const res = await app.inject(`/v1/accounts/${bad}/positions`);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    }
    expect((await app.inject(`/v1/accounts/${r.taker}/activity?before=abc`)).statusCode).toBe(400);
    expect((await app.inject(`/v1/accounts/${r.taker}/positions?status=pending`)).statusCode).toBe(400);
  });

  it('GET /v1/accounts/:address/activity: newest first, paginated without gaps or repeats', async () => {
    const all: ActivityItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const res = await app.inject(`/v1/accounts/${r.taker}/activity?limit=3${cursor ? `&before=${cursor}` : ''}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as ActivityPage;
      expect(body.items.length).toBeLessThanOrEqual(3);
      all.push(...body.items);
      cursor = body.next;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    const keys = all.map((a) => `${a.block}:${a.logIndex}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (let i = 1; i < all.length; i++) expect(all[i - 1]!.block > all[i]!.block || (all[i - 1]!.block === all[i]!.block && all[i - 1]!.logIndex > all[i]!.logIndex)).toBe(true);
    const one = (await app.inject(`/v1/accounts/${r.taker}/activity?limit=200`)).json() as ActivityPage;
    expect(one.items.map((a) => `${a.block}:${a.logIndex}`)).toEqual(keys);
    const kinds = new Set(all.map((a) => a.kind));
    for (const k of ['deposit', 'swap', 'approval', 'position_open', 'position_liquidate', 'position_settled']) expect(kinds.has(k), k).toBe(true);
    const deposit = all.find((a) => a.tx === r.depositTx)!;
    expect(deposit.data).toMatchObject({ token: 'USDG', amount: '9', from: r.taker, to: r.taker });
    const swap = all.find((a) => a.tx === r.swapTx)!;
    expect(swap.data).toMatchObject({ tokenIn: 'USDG', tokenOut: 'TSLA', amountIn: '100' });
    const keeper = (await app.inject(`/v1/accounts/${r.keeper}/activity`)).json() as ActivityPage;
    expect(keeper.items.map((a) => a.kind)).toEqual(['liquidation_reward']);
  });

  it('GET /v1/markets/:symbol/funding', async () => {
    const res = await app.inject('/v1/markets/TSLA/funding?limit=500');
    expect(res.statusCode).toBe(200);
    const points = res.json() as Array<{ t: number; rate: string; index: string; block: number }>;
    expect(points.length).toBeGreaterThan(0);
    for (let i = 1; i < points.length; i++) expect(points[i]!.block).toBeGreaterThanOrEqual(points[i - 1]!.block);
    for (const p of points) {
      expect(p.rate).toMatch(/^-?\d+(\.\d+)?$/);
      expect(Number(p.rate)).toBeLessThanOrEqual(0.01); // the cap: 0.01%/h
    }
    expect((await app.inject('/v1/markets/NVDA/funding')).statusCode).toBe(404); // not in this deployment
    expect((await app.inject('/v1/markets/NOPE/funding')).statusCode).toBe(404);
  });

  it('GET /v1/health: the on-chain summary', async () => {
    const res = await app.inject('/v1/health');
    const h = res.json();
    expect(h.onchain).not.toBeNull();
    expect(h.onchain.chainId).toBe(31337);
    expect(h.onchain.indexer.block).toBeGreaterThan(0);
    expect(h.onchain.relayer).toMatchObject({ enabled: true, address: r.relayer, sending: true, balanceLow: false });
    // The signer had no quote for AMZN (its fake quote API had none), so it never pushed one.
    expect(h.onchain.relayer.markets).toMatchObject({ AMZN: 'no-snapshot' });
    expect(h.onchain.reasons).toEqual([]);
    expect(h.signer).toBeLessThanOrEqual(60);
    expect(h.onchain.keeper).toMatchObject({ enabled: true, address: r.keeper, liquidations: 1, forcedExits: 1 });
    expect(JSON.stringify(h)).not.toMatch(/[0-9a-f]{64}/i); // no keys (nor anything key-shaped)
  });
});
