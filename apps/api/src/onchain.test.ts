/**
 * Phase 3 read endpoints (/v1/deployment, /v1/accounts/:address/positions|activity, /v1/markets/:symbol/funding)
 * and the on-chain summary in /v1/health, with fakes; the Prisma reader against a real Postgres when
 * TEST_DATABASE_URL points at a migrated scratch database (skipped otherwise).
 */
import { parseDeployment, type Deployment, type OnchainStatus, type RoleHealth } from '@velum/config/src/onchain';
import { Prisma, PrismaClient } from '@velum/db';
import { getAddress } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL_FOR_MAC } from './__fixtures__/mac';
import { buildApp } from './app';
import type { ApiEnv } from './env';
import type { AppDeps, CacheReader } from './lib/deps';
import { parseActivityCursor, positionView, prismaOnchain, staticDeployment, type OnchainReader } from './lib/onchain';
import { onchainSummary } from './routes/health';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const TAKER = '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65';
const raw = { chainId: 46630, startBlock: 7, contracts: { vault: A(1), oracle: A(2), spotPools: A(3), makerBook: A(4), perpsMarkets: '0xa513e6e4b8f2a923d98304ec87f64353c4d5c853' }, tokens: { USDG: A(10), TSLA: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512', AMZN: A(12) }, priceRelayer: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', guardian: A(0) };
const deployment = (() => {
  const r = parseDeployment(raw, 46630);
  if (!r.ok) throw new Error(r.error);
  return r.deployment;
})();

const env: ApiEnv = {
  host: '127.0.0.1',
  port: 0,
  databaseUrl: TEST_DATABASE_URL_FOR_MAC,
  redisUrl: 'redis://x',
  redis: { db: 0 },
  corsOrigins: false,
  rateReadPerMin: 120,
  rateQuotePerMin: 30,
  rateHealthPerMin: 60,
  rateMarketsPerMin: 600,
  rpcUrl: 'http://localhost:1',
  chainId: 46630,
  network: 'testnet',
  demoMode: true,
  logLevel: 'silent',
  proxySecret: null,
  socketPath: null,
};

const NOW = 1_794_646_800_000;
const sender = { enabled: true, address: getAddress(raw.priceRelayer), sending: true, balanceWei: '10', balanceLow: false, inflight: false, stuck: false, gasCapped: false, lastTx: null, lastConfirmedAt: null, error: null };
const status = (o: Partial<OnchainStatus> = {}): OnchainStatus => ({
  v: 1,
  at: NOW - 3000,
  chainId: 46630,
  deployment: raw.contracts.perpsMarkets,
  indexer: { enabled: true, block: 120, head: 123, lagBlocks: 3, lastRunAt: NOW - 1000, reorgs: 0, error: null },
  relayer: { ...sender, lastPushAt: NOW - 4000, lastPushBlockTime: 1, sequencerUp: true, markets: { TSLA: 'pushed', AMZN: 'closed' } },
  keeper: { ...sender, lastRunAt: NOW - 2000, liquidations: 2, forcedExits: 0, fundingAdvances: 1, coverPayouts: 0 },
  ...o,
});

function fakeReader() {
  const calls: Array<[string, unknown[]]> = [];
  const reader: OnchainReader & { fail?: boolean } = {
    async positions(...a) {
      calls.push(['positions', a.slice(1)]);
      if (reader.fail) throw new Error('db down');
      return [];
    },
    async activity(...a) {
      calls.push(['activity', a.slice(1)]);
      return { items: [], next: null };
    },
    async funding(...a) {
      calls.push(['funding', a.slice(1)]);
      return [{ t: 1, rate: '0.01', index: '0.5', block: 3, tx: '0xab' }];
    },
    async closeOnly() {
      return { [raw.tokens.TSLA]: true };
    },
  };
  return { reader, calls };
}

async function make(o: { d?: Deployment | null; s?: OnchainStatus | null; reader?: OnchainReader; rate?: number } = {}) {
  const cache: CacheReader = {
    ping: async () => true,
    snapshots: async () => new Map(),
    candles: async () => null,
    heartbeat: async () => NOW - 2000,
    onchainStatus: async () => (o.s === undefined ? status() : o.s),
  };
  const deps: AppDeps = {
    env: { ...env, rateReadPerMin: o.rate ?? 120 },
    cache,
    db: { ping: async () => true, candles: async () => [], publishedPools: async () => [] },
    chain: { blockNumber: async () => 1n },
    deployment: staticDeployment(o.d === undefined ? deployment : o.d),
    onchain: o.reader ?? fakeReader().reader,
    now: () => NOW,
  };
  return buildApp(deps);
}

describe('GET /v1/deployment', () => {
  it('404 until a deployment file exists for the configured chain', async () => {
    const res = await (await make({ d: null })).inject('/v1/deployment');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'No Velum contracts are deployed on this network yet.' } });
  });
  it('checksummed addresses, guard state and indexer progress', async () => {
    const res = await (await make()).inject('/v1/deployment');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      chainId: 46630,
      startBlock: 7,
      contracts: { vault: getAddress(A(1)), oracle: getAddress(A(2)), spotPools: getAddress(A(3)), makerBook: getAddress(A(4)), perpsMarkets: '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853' },
      tokens: { USDG: getAddress(A(10)), TSLA: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', AMZN: getAddress(A(12)) },
      priceRelayer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      guard: { guardian: null, closeOnly: { TSLA: true, AMZN: false } },
      indexer: { block: 120, lag: 3, age: 3 },
    });
  });
  it('ignores a status written for another deployment', async () => {
    const res = await (await make({ s: status({ deployment: A(99) }) })).inject('/v1/deployment');
    expect(res.json().indexer).toBeNull();
  });
});

describe('GET /v1/accounts/:address/*', () => {
  it('accepts any letter case, queries in lower case, validates strictly', async () => {
    const { reader, calls } = fakeReader();
    const app = await make({ reader });
    expect((await app.inject(`/v1/accounts/${getAddress(TAKER)}/positions?status=open&limit=5`)).statusCode).toBe(200);
    expect((await app.inject(`/v1/accounts/0x${TAKER.slice(2).toUpperCase()}/positions`)).statusCode).toBe(200);
    expect(calls).toEqual([
      ['positions', [TAKER, 'open', 5]],
      ['positions', [TAKER, 'all', 100]],
    ]);
    for (const bad of ['0x123', `0x${'z'.repeat(40)}`, TAKER.slice(2), `${TAKER}0`, `${TAKER} `]) {
      const res = await app.inject(`/v1/accounts/${encodeURIComponent(bad)}/positions`);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error).toEqual({ code: 'BAD_REQUEST', message: 'address must be 0x followed by 40 hex digits (any letter case).' });
    }
    for (const q of ['status=nope', 'limit=0', 'limit=501']) expect((await app.inject(`/v1/accounts/${TAKER}/positions?${q}`)).statusCode, q).toBe(400);
  });
  it('activity: an opaque cursor, a bounded limit', async () => {
    const { reader, calls } = fakeReader();
    const app = await make({ reader });
    expect((await app.inject(`/v1/accounts/${TAKER}/activity?before=153118480-7&limit=20`)).json()).toEqual({ items: [], next: null });
    expect(calls[0]).toEqual(['activity', [TAKER, 20, { block: 153118480n, logIndex: 7 }]]);
    expect((await app.inject(`/v1/accounts/${TAKER}/activity?before=12`)).statusCode).toBe(400);
    expect((await app.inject(`/v1/accounts/${TAKER}/activity?limit=201`)).statusCode).toBe(400);
    expect(parseActivityCursor('1-2')).toEqual({ block: 1n, logIndex: 2 });
    expect(parseActivityCursor(undefined)).toBeNull();
    expect(parseActivityCursor('-1-2')).toBe('invalid');
    // Audit L-9: out of the columns' range is a 400, not a database error (503).
    expect(parseActivityCursor('9223372036854775807-2147483647')).toEqual({ block: 2n ** 63n - 1n, logIndex: 2 ** 31 - 1 });
    expect(parseActivityCursor('9223372036854775808-1')).toBe('invalid');
    expect(parseActivityCursor('9999999999999999999-1')).toBe('invalid');
    expect(parseActivityCursor('1-2147483648')).toBe('invalid');
    expect((await app.inject(`/v1/accounts/${TAKER}/activity?before=9999999999999999999-1`)).statusCode).toBe(400);
  });
  it('404 before a deployment, 503 when the index cannot be read', async () => {
    expect((await (await make({ d: null })).inject(`/v1/accounts/${TAKER}/positions`)).statusCode).toBe(404);
    const { reader } = fakeReader();
    reader.fail = true;
    const res = await (await make({ reader })).inject(`/v1/accounts/${TAKER}/positions`);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('UNAVAILABLE');
  });
  it('counts against the read rate limit', async () => {
    const app = await make({ rate: 2 });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await app.inject(`/v1/accounts/${TAKER}/activity`)).statusCode);
    expect(codes).toEqual([200, 200, 429]);
  });
});

describe('GET /v1/markets/:symbol/funding', () => {
  it('the deployment token of a listed market; 404 otherwise', async () => {
    const { reader, calls } = fakeReader();
    const app = await make({ reader });
    const res = await app.inject('/v1/markets/tsla/funding?limit=10');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ t: 1, rate: '0.01', index: '0.5', block: 3, tx: '0xab' }]);
    expect(calls[0]).toEqual(['funding', [raw.tokens.TSLA, 10]]);
    expect((await app.inject('/v1/markets/NVDA/funding')).json().error.message).toMatch(/not listed in this deployment/);
    expect((await app.inject('/v1/markets/XYZ/funding')).statusCode).toBe(404);
    expect((await (await make({ d: null })).inject('/v1/markets/TSLA/funding')).statusCode).toBe(404);
  });
});

describe('/v1/health on-chain summary', () => {
  it('null while the on-chain workers are off, or for another chain', async () => {
    expect((await (await make({ s: null })).inject('/v1/health')).json().onchain).toBeNull();
    expect((await (await make({ s: status({ chainId: 4663 }) })).inject('/v1/health')).json().onchain).toBeNull();
  });
  it('summarises the indexer, relayer and keeper without secrets, never failing the check', async () => {
    const res = await (await make()).inject('/v1/health');
    expect(res.statusCode).toBe(200);
    const h = res.json();
    expect(h.onchain).toEqual({
      ok: true,
      reasons: [],
      age: 3,
      chainId: 46630,
      indexer: { block: 120, head: 123, lag: 3, reorgs: 0, lastRun: 1, error: null },
      relayer: { enabled: true, address: getAddress(raw.priceRelayer), sending: true, lastPush: 4, balanceLow: false, stuck: false, gasCapped: false, sequencerUp: true, markets: { TSLA: 'pushed', AMZN: 'closed' }, error: null },
      keeper: { enabled: true, address: getAddress(raw.priceRelayer), sending: true, lastRun: 2, balanceLow: false, stuck: false, gasCapped: false, liquidations: 2, forcedExits: 0, error: null },
    });
    // deploy.sh reads "workers":<n> followed by another field.
    expect(res.body).toMatch(/"workers":\d+,/);
    const low = await (await make({ s: status({ relayer: { ...status().relayer, balanceLow: true } }) })).inject('/v1/health');
    expect(low.statusCode).toBe(200);
    expect(low.json().onchain.ok).toBe(false);
  });
  it('ok is false for an old status or an indexer error', () => {
    expect(onchainSummary(status({ at: NOW - 61_000 }), NOW)!.ok).toBe(false);
    expect(onchainSummary(status({ indexer: { ...status().indexer, error: 'RPC down' } }), NOW)!.ok).toBe(false);
    // A disabled keeper with an error ("KEEPER_PRIVATE_KEY not set") does not make it unhealthy.
    expect(onchainSummary(status({ keeper: { ...status().keeper, enabled: false, error: 'KEEPER_PRIVATE_KEY not set' } }), NOW)!.ok).toBe(true);
  });

  // Audit M-3: a Redis tenant holding the role locks or deleting the schedulers stopped every role while ok stayed true.
  const roles = (o: Partial<Record<'relayer' | 'keeper' | 'indexer', Partial<RoleHealth>>> = {}) => ({
    relayer: { enabled: true, lockHeld: true, lastOkAt: NOW - 1000, everyMs: 1000, ...o.relayer },
    keeper: { enabled: true, lockHeld: true, lastOkAt: NOW - 2000, everyMs: 3000, ...o.keeper },
    indexer: { enabled: true, lockHeld: true, lastOkAt: NOW - 1000, everyMs: 2000, ...o.indexer },
  });
  const live = (o: Partial<OnchainStatus> = {}) => status({ startedAt: NOW - 600_000, pushIntervalMs: 9000, roles: roles(), error: null, ...o });
  const open = () => true;
  const closed = () => false;
  it('ok with every role holding its lock and ticking, and a push within two intervals in session', () => {
    expect(onchainSummary(live(), NOW, open)).toMatchObject({ ok: true, reasons: [] });
  });
  it('not ok when this process does not hold a role lock, with the reason (M-3)', () => {
    const s = onchainSummary(live({ roles: roles({ relayer: { lockHeld: false }, indexer: { lockHeld: false } }) }), NOW, open)!;
    expect(s.ok).toBe(false);
    expect(s.reasons).toEqual([expect.stringMatching(/^relayer: this process does not hold the role's lock/), expect.stringMatching(/^indexer: this process does not hold/)]);
    // A role that is off (no key) is not expected to hold anything.
    expect(onchainSummary(live({ roles: roles({ keeper: { enabled: false, lockHeld: null, lastOkAt: null } }) }), NOW, open)!.ok).toBe(true);
  });
  it('not ok when a role has not ticked successfully for a minute (a deleted scheduler), or never since the start', () => {
    expect(onchainSummary(live({ roles: roles({ keeper: { lastOkAt: NOW - 61_000 } }) }), NOW, open)!.reasons).toEqual(['keeper: no successful tick for 61 s']);
    expect(onchainSummary(live({ roles: roles({ indexer: { lastOkAt: null } }) }), NOW, open)!.reasons).toEqual(['indexer: no successful tick for 600 s']);
    // A slow role gets five of its intervals.
    expect(onchainSummary(live({ roles: roles({ keeper: { everyMs: 30_000, lastOkAt: NOW - 120_000 } }) }), NOW, open)!.ok).toBe(true);
  });
  it('not ok during an open session when no push was confirmed for more than two push intervals', () => {
    const stale = live({ relayer: { ...status().relayer, lastPushAt: NOW - 19_000 } });
    expect(onchainSummary(stale, NOW, open)!.reasons).toEqual(['relayer: no confirmed push for 19 s during the market session']);
    expect(onchainSummary(stale, NOW, closed)!.ok).toBe(true);
    expect(onchainSummary(live({ relayer: { ...status().relayer, lastPushAt: NOW - 18_000 } }), NOW, open)!.ok).toBe(true);
    // Never pushed since a start 10 minutes ago.
    expect(onchainSummary(live({ relayer: { ...status().relayer, lastPushAt: null } }), NOW, open)!.ok).toBe(false);
    // Not expected: the relayer cannot send (mainnet lock), or the sequencer is down (reported as such).
    expect(onchainSummary(live({ relayer: { ...stale.relayer, sending: false } }), NOW, open)!.ok).toBe(true);
    expect(onchainSummary(live({ relayer: { ...stale.relayer, sequencerUp: false } }), NOW, open)!.ok).toBe(true);
  });
  it('not ok on a sender alert or while the on-chain workers are disabled, with the reason and no secret', () => {
    const alert = 'nonce 7 (push:TSLA) not mined after 6 replacements: cancelling it at up to the 1 gwei ceiling until it is used';
    expect(onchainSummary(live({ relayer: { ...status().relayer, alerts: [alert] } }), NOW, open)!.reasons).toEqual([`relayer: ${alert}`]);
    const off = onchainSummary(live({ error: 'REDIS_URL is not a unix socket: the on-chain workers run only on Velum\'s own Redis' }), NOW, open)!;
    expect(off.ok).toBe(false);
    expect(off.reasons[0]).toMatch(/^on-chain workers disabled: REDIS_URL is not a unix socket/);
  });
});

describe('position view', () => {
  it('formats base units exactly and checksums addresses', () => {
    const D = (v: string) => new Prisma.Decimal(v);
    const row = {
      chainId: 46630,
      perps: raw.contracts.perpsMarkets,
      positionId: 12n,
      market: raw.tokens.TSLA,
      symbol: 'TSLA',
      taker: TAKER,
      maker: A(77),
      isLong: false,
      qty: D('2550000000000000000'),
      entry: D('391845165000000000000'),
      takerMargin: D('200000000'),
      makerMargin: D('200000000'),
      size: D('1000000000'),
      offerId: 3n,
      status: 'liquidated' as const,
      openedBlock: 10n,
      openedAt: new Date(1000),
      openTx: '0xaa',
      closedBlock: 20n,
      closedAt: new Date(2000),
      closeTx: '0xbb',
      closePrice: D('440000000000000000000'),
      exitPrice: D('440000000000000000000'),
      takerPnl: D('-122000001'),
      takerFunding: D('1'),
      fee: D('11220000'),
      takerOut: D('0'),
      makerOut: D('394390000'),
      liquidator: A(5),
      liquidatedSide: 'taker',
      liquidationPrice: D('440000000000000000000'),
      penalty: D('11220000'),
      reward: D('5610000'),
      shortfall: D('0'),
      exitRequester: null,
      exitRequestedAt: null,
      exitSettleAfter: null,
      exitAtEntry: null,
      lastBlock: 20n,
      lastLogIndex: 4,
    };
    const v = positionView(row, A(77), 6);
    expect(v).toMatchObject({ id: '12', role: 'maker', side: 'short', qty: '2.55', entry: '391.845165', size: '1000', takerPnl: '-122.000001', takerFunding: '0.000001', fee: '11.22', taker: getAddress(TAKER), forcedExit: null });
    expect(v.liquidation).toEqual({ liquidator: getAddress(A(5)), side: 'taker', price: '440', penalty: '11.22', reward: '5.61', shortfall: '0' });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('Prisma reader on Postgres', () => {
  const CHAIN = 990_002;
  let prisma: PrismaClient;
  let d: Deployment;
  const clean = async () => {
    for (const t of ['perpPosition', 'accountActivity', 'fundingPoint', 'onchainToken', 'chainEvent'] as const) await (prisma[t] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { chainId: CHAIN } });
  };
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
    const r = parseDeployment({ ...raw, chainId: CHAIN }, CHAIN);
    if (!r.ok) throw new Error(r.error);
    d = r.deployment;
    await clean();
    await prisma.onchainToken.create({ data: { chainId: CHAIN, address: d.tokens.USDG!, symbol: 'USDG', decimals: 6 } });
    const base = { chainId: CHAIN, contract: d.contracts.vault, kind: 'deposit', data: { amount: '1' }, at: new Date(0) };
    // 5 rows for the taker over 3 blocks, one row of another account, one of another deployment's contract.
    await prisma.accountActivity.createMany({
      data: [
        { ...base, txHash: '0x1', logIndex: 0, account: TAKER, block: 1n },
        { ...base, txHash: '0x2', logIndex: 1, account: TAKER, block: 2n },
        { ...base, txHash: '0x2', logIndex: 3, account: TAKER, block: 2n, data: { to: A(42) } },
        { ...base, txHash: '0x3', logIndex: 0, account: TAKER, block: 3n },
        { ...base, txHash: '0x3', logIndex: 2, account: TAKER, block: 3n },
        { ...base, txHash: '0x4', logIndex: 0, account: A(9), block: 4n },
        { ...base, txHash: '0x5', logIndex: 0, account: TAKER, block: 5n, contract: A(999) },
      ],
    });
    const pos = { chainId: CHAIN, perps: d.contracts.perpsMarkets, market: d.tokens.TSLA!, symbol: 'TSLA', maker: A(77), isLong: true, qty: new Prisma.Decimal('1'), entry: new Prisma.Decimal('1'), takerMargin: new Prisma.Decimal('1'), makerMargin: new Prisma.Decimal('1'), openedAt: new Date(0), openTx: '0x', lastLogIndex: 0 };
    await prisma.perpPosition.createMany({
      data: [
        { ...pos, positionId: 1n, taker: TAKER, status: 'closed', openedBlock: 1n, lastBlock: 1n },
        { ...pos, positionId: 2n, taker: TAKER, status: 'open', openedBlock: 2n, lastBlock: 2n },
        { ...pos, positionId: 3n, taker: A(8), maker: TAKER, status: 'liquidated', openedBlock: 3n, lastBlock: 3n },
        { ...pos, positionId: 4n, taker: TAKER, perps: A(999), status: 'open', openedBlock: 4n, lastBlock: 4n },
      ],
    });
    await prisma.fundingPoint.createMany({
      data: [1, 2, 3].map((i) => ({ chainId: CHAIN, txHash: `0xf${i}`, logIndex: 0, perps: d.contracts.perpsMarkets, market: d.tokens.TSLA!, rate: new Prisma.Decimal(i === 2 ? '-100000000000000' : '42000000000000'), index: new Prisma.Decimal(`${i}000000000000000000`), timestamp: new Date(i * 1000), block: BigInt(i) })),
    });
    await prisma.chainEvent.createMany({
      data: [
        { chainId: CHAIN, kind: 'CloseOnlySet', address: d.contracts.perpsMarkets, txHash: '0xc1', logIndex: 0, block: 1n, data: { market: d.tokens.TSLA!, closeOnly: true } },
        { chainId: CHAIN, kind: 'CloseOnlySet', address: d.contracts.perpsMarkets, txHash: '0xc2', logIndex: 0, block: 2n, data: { market: d.tokens.TSLA!, closeOnly: false } },
        { chainId: CHAIN, kind: 'CloseOnlySet', address: d.contracts.perpsMarkets, txHash: '0xc3', logIndex: 0, block: 3n, data: { market: d.tokens.AMZN!, closeOnly: true } },
      ],
    });
  });
  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
  });

  it('positions of the current deployment, taker or maker, open first', async () => {
    const r = prismaOnchain(prisma);
    expect((await r.positions(d, TAKER, 'all', 100)).map((p) => [p.id, p.role, p.status])).toEqual([
      ['2', 'taker', 'open'],
      ['3', 'maker', 'liquidated'],
      ['1', 'taker', 'closed'],
    ]);
    expect((await r.positions(d, TAKER, 'closed', 100)).map((p) => p.id)).toEqual(['3', '1']);
    expect((await r.positions(d, TAKER, 'open', 100)).map((p) => p.id)).toEqual(['2']);
    // Audit L-9: an open position older than the newest `limit` rows is still returned first.
    expect((await r.positions(d, TAKER, 'all', 1)).map((p) => p.id)).toEqual(['2']);
    expect((await r.positions(d, TAKER, 'all', 2)).map((p) => p.id)).toEqual(['2', '3']);
  });

  it('activity pages newest first without gaps or repeats, scoped to the deployment', async () => {
    const r = prismaOnchain(prisma);
    const p1 = await r.activity(d, TAKER, 2, null);
    expect(p1.items.map((i) => `${i.block}-${i.logIndex}`)).toEqual(['3-2', '3-0']);
    expect(p1.next).toBe('3-0');
    const p2 = await r.activity(d, TAKER, 2, parseActivityCursor(p1.next!) as { block: bigint; logIndex: number });
    expect(p2.items.map((i) => `${i.block}-${i.logIndex}`)).toEqual(['2-3', '2-1']);
    expect(p2.items[0]!.data).toEqual({ to: getAddress(A(42)) });
    const p3 = await r.activity(d, TAKER, 2, parseActivityCursor(p2.next!) as { block: bigint; logIndex: number });
    expect(p3).toMatchObject({ next: null });
    expect(p3.items.map((i) => `${i.block}-${i.logIndex}`)).toEqual(['1-0']);
  });

  it('funding oldest first in percent per hour, and the latest close-only flags', async () => {
    const r = prismaOnchain(prisma);
    expect(await r.funding(d, d.tokens.TSLA!, 2)).toEqual([
      { t: 2000, rate: '-0.01', index: '2', block: 2, tx: '0xf2' },
      { t: 3000, rate: '0.0042', index: '3', block: 3, tx: '0xf3' },
    ]);
    expect(await r.closeOnly(d)).toEqual({ [d.tokens.TSLA!]: false, [d.tokens.AMZN!]: true });
  });

  it('the latest close-only flag per market however long the history (audit L-9: an oldest-first read capped at 1,000)', async () => {
    const r = prismaOnchain(prisma);
    const many = Array.from({ length: 1200 }, (_, i) => ({ chainId: CHAIN, kind: 'CloseOnlySet', address: d.contracts.perpsMarkets, market: d.tokens.TSLA!, txHash: `0xd${i}`, logIndex: 1, block: 10n + BigInt(i), data: { market: d.tokens.TSLA!, closeOnly: i % 2 === 1 } }));
    await prisma.chainEvent.createMany({ data: many });
    expect(await r.closeOnly(d)).toEqual({ [d.tokens.TSLA!]: true, [d.tokens.AMZN!]: true });
    await prisma.chainEvent.create({ data: { chainId: CHAIN, kind: 'CloseOnlySet', address: d.contracts.perpsMarkets, txHash: '0xdlast', logIndex: 0, block: 5000n, data: { market: d.tokens.TSLA!, closeOnly: false } } });
    expect(await r.closeOnly(d)).toEqual({ [d.tokens.TSLA!]: false, [d.tokens.AMZN!]: true });
  });
});
