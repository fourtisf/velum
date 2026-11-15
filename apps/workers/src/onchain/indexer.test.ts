/**
 * The indexer and its projections against a real Postgres (TEST_DATABASE_URL, a migrated scratch database;
 * skipped without it) and a fake chain: a full position lifecycle, idempotency, unknown events, the
 * eth_getLogs range halving, and a reorg that rewinds and refolds the touched state.
 */
import { parseDeployment, type Deployment } from '@velum/config/src/onchain';
import { PrismaClient } from '@velum/db';
import { encodeAbiParameters, encodeEventTopics, keccak256, toEventSelector, toHex, type AbiEvent, type Hex } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../lib/log';
import { abis } from './chain';
import type { RawLog } from './decode';
import { Indexer, type IndexerClient } from './indexer';

const DB = process.env.TEST_DATABASE_URL;
const CHAIN = 990_001;
const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const C = { vault: A(1), oracle: A(2), spotPools: A(3), makerBook: A(4), perpsMarkets: A(5) };
const T = { USDG: A(10), TSLA: A(11) };
const TAKER = A(100);
const MAKER = A(101);
const E6 = 10n ** 6n;
const E18 = 10n ** 18n;
const silent: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

type EventSpec = { address: Hex; abi: readonly unknown[]; eventName: string; args: Record<string, unknown>; data: Array<{ type: string }>; values: unknown[] };
interface Block {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
  logs: EventSpec[];
}

function mkLog(e: EventSpec, b: Block, logIndex: number, tx: Hex): RawLog {
  const topics = (encodeEventTopics as unknown as (p: { abi: unknown; eventName: string; args: unknown }) => Hex[])({ abi: e.abi, eventName: e.eventName, args: e.args });
  return { address: e.address, topics, data: e.data.length ? encodeAbiParameters(e.data as never, e.values as never) : '0x', blockNumber: b.number, blockHash: b.hash, transactionHash: tx, logIndex };
}

/** A chain of blocks; `fork(n, salt)` replaces everything from block n with blocks of another branch. */
class FakeChain implements IndexerClient {
  blocks: Block[] = [];
  maxRange = 1000n;
  /** Most logs one eth_getLogs answer may hold (a provider's response cap). */
  maxLogs = Infinity;
  /** Whether eth_getBlockReceipts is served. */
  receipts = true;
  /** Heads to answer before the real one (a load-balanced RPC answering from a node that lags). */
  laggingHeads: bigint[] = [];
  getLogsCalls: Array<[bigint, bigint]> = [];
  requests: string[] = [];
  constructor(n: number) {
    for (let i = 0; i < n; i++) this.append([]);
  }
  append(logs: EventSpec[], salt = 'a'): Block {
    const number = BigInt(this.blocks.length);
    const parentHash = this.blocks.at(-1)?.hash ?? (`0x${'00'.repeat(32)}` as Hex);
    const b = { number, parentHash, hash: keccak256(toHex(`${salt}:${number}:${parentHash}`)), timestamp: 1_700_000_000n + number * 2n, logs };
    this.blocks.push(b);
    return b;
  }
  fork(from: number, salt: string, branch: EventSpec[][]): void {
    this.blocks = this.blocks.slice(0, from);
    for (const logs of branch) this.append(logs, salt);
  }
  getBlockNumber = (async () => this.laggingHeads.shift() ?? BigInt(this.blocks.length - 1)) as IndexerClient['getBlockNumber'];
  private logsOf(fromBlock: bigint, toBlock: bigint): RawLog[] {
    const out: RawLog[] = [];
    // One transaction per block (so an offer fill and the open it backs share a transaction, as on chain).
    for (const b of this.blocks.slice(Number(fromBlock), Number(toBlock) + 1)) b.logs.forEach((e, i) => out.push(mkLog(e, b, i, keccak256(toHex(`tx:${b.hash}`)))));
    return out;
  }
  request = (async ({ method, params }: { method: string; params: [Hex] }) => {
    this.requests.push(method);
    if (method !== 'eth_getBlockReceipts' || !this.receipts) throw new Error(`the method ${method} does not exist/is not available`);
    const n = BigInt(params[0]);
    const logs = this.logsOf(n, n).map((l) => ({ ...l, blockNumber: toHex(l.blockNumber), logIndex: toHex(l.logIndex) }));
    return logs.length ? [{ logs }] : [];
  }) as unknown as NonNullable<IndexerClient['request']>;
  getBlock = (async ({ blockNumber }: { blockNumber: bigint }) => {
    const b = this.blocks[Number(blockNumber)];
    if (!b) throw new Error('block not found');
    return { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp };
  }) as unknown as IndexerClient['getBlock'];
  getLogs = (async ({ fromBlock, toBlock, address, event }: { fromBlock: bigint; toBlock: bigint; address?: Hex | Hex[]; event?: AbiEvent }) => {
    this.getLogsCalls.push([fromBlock, toBlock]);
    if (toBlock - fromBlock + 1n > this.maxRange) throw new Error('query exceeds max block range 1000');
    const addrs = address === undefined ? null : new Set((Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase()));
    const topic = event ? toEventSelector(event) : null;
    const out = this.logsOf(fromBlock, toBlock).filter((l) => (!addrs || addrs.has(l.address.toLowerCase())) && (!topic || l.topics[0] === topic));
    if (out.length > this.maxLogs) throw new Error(`Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap of ${this.maxLogs} logs in the response.`);
    return out;
  }) as unknown as IndexerClient['getLogs'];
  readContract = (async ({ address }: { address: Hex }) => (address === T.USDG ? 6 : 18)) as unknown as IndexerClient['readContract'];
}

const deposit = (from: Hex, amount: bigint): EventSpec => ({ address: C.vault, abi: abis.vault, eventName: 'Deposited', args: { from, to: from, token: T.USDG }, data: [{ type: 'uint256' }], values: [amount] });
const offerPosted = (id: bigint): EventSpec => ({
  address: C.makerBook,
  abi: abis.makerBook,
  eventName: 'OfferPosted',
  args: { id, maker: MAKER, market: T.TSLA },
  data: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint64' }],
  values: [10_000n * E6, 5_000n * E6, 10, 10, 1_800_000_000n],
});
const offerFilled = (id: bigint, size: bigint, left: bigint): EventSpec => ({ address: C.makerBook, abi: abis.makerBook, eventName: 'OfferFilled', args: { id }, data: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], values: [size, size / 5n, left] });
const positionChanged = (id: bigint, action: number, takerMargin: bigint, price: bigint): EventSpec => ({
  address: C.perpsMarkets,
  abi: abis.perpsMarkets,
  eventName: 'PositionChanged',
  args: { id, market: T.TSLA, action },
  data: ['address', 'address', 'bool', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'].map((type) => ({ type })),
  values: [TAKER, MAKER, true, 25n * 10n ** 17n, 400n * E18, takerMargin, 200n * E6, price],
});
const settled = (id: bigint): EventSpec => ({
  address: C.perpsMarkets,
  abi: abis.perpsMarkets,
  eventName: 'PositionSettled',
  args: { id },
  data: ['uint256', 'int256', 'int256', 'uint256', 'uint256', 'uint256'].map((type) => ({ type })),
  values: [440n * E18, 100n * E6, -1n * E6, 600_000n, 300n * E6, 99_400_000n],
});
const funding = (index: bigint): EventSpec => ({ address: C.perpsMarkets, abi: abis.perpsMarkets, eventName: 'FundingAdvanced', args: { market: T.TSLA }, data: [{ type: 'int256' }, { type: 'int256' }, { type: 'uint256' }], values: [10n ** 14n, index, 1_700_000_100n] });
/** An event no ABI knows (a guarded-launch vault event, say). */
const unknown: EventSpec = { address: C.vault, abi: [{ type: 'event', name: 'DepositCapSet', inputs: [{ name: 'token', type: 'address', indexed: true }, { name: 'cap', type: 'uint256', indexed: false }] }], eventName: 'DepositCapSet', args: { token: T.USDG }, data: [{ type: 'uint256' }], values: [5n] };

describe.skipIf(!DB)('indexer on Postgres', () => {
  let prisma: PrismaClient;
  let d: Deployment;

  const clean = async () => {
    for (const t of ['chainEvent', 'perpPosition', 'perpTrade', 'makerOffer', 'spotPoolState', 'spotSwap', 'spotLiquidity', 'vaultTransfer', 'fundingPoint', 'accountActivity', 'indexedBlock', 'indexerCheckpoint', 'onchainToken'] as const) {
      await (prisma[t] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { chainId: CHAIN } });
    }
  };
  const run = async (ix: Indexer) => {
    for (let i = 0; i < 50; i++) if ((await ix.step()) === 'idle') return;
    throw new Error('indexer never idle');
  };
  const position = () => prisma.perpPosition.findUnique({ where: { chainId_perps_positionId: { chainId: CHAIN, perps: C.perpsMarkets, positionId: 1n } } });

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB! } } });
    const r = parseDeployment({ chainId: CHAIN, startBlock: 1, contracts: C, tokens: T, priceRelayer: A(50), guardian: A(0) }, CHAIN);
    if (!r.ok) throw new Error(r.error);
    d = r.deployment;
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
  });

  it('folds a position lifecycle into positions, trades, offers, funding and activity; replays are idempotent', async () => {
    const chain = new FakeChain(2);
    chain.append([deposit(TAKER, 5_000n * E6), offerPosted(1n)]);
    chain.append([offerFilled(1n, 1_000n * E6, 9_800n * E6), positionChanged(1n, 0, 200n * E6, 400n * E18), funding(5n)]);
    chain.append([positionChanged(1n, 2, 250n * E6, 0n)]);
    chain.append([unknown]);
    chain.append([positionChanged(1n, 1, 250n * E6, 441n * E18), settled(1n)]);
    const ix = new Indexer({ client: chain, prisma, deployment: d, chainId: CHAIN, confirmations: 0, chunkBlocks: 100, startBlock: null, log: silent });
    await ix.init();
    await run(ix);

    const p = (await position())!;
    expect(p).toMatchObject({ status: 'closed', taker: TAKER, maker: MAKER, isLong: true, offerId: 1n, symbol: 'TSLA', openedBlock: 3n, closedBlock: 6n });
    expect(p.size?.toFixed()).toBe((1_000n * E6).toString());
    expect(p.takerMargin.toFixed()).toBe((250n * E6).toString());
    expect(p.exitPrice?.toFixed()).toBe((440n * E18).toString());
    expect(p.takerFunding?.toFixed()).toBe((-1n * E6).toString());
    const trades = await prisma.perpTrade.findMany({ where: { chainId: CHAIN }, orderBy: { block: 'asc' } });
    expect(trades.map((t) => [t.kind, t.notional.toFixed(), t.fee.toFixed()])).toEqual([
      ['open', (1_000n * E6).toString(), '600000'],
      ['close', (1_100n * E6).toString(), '600000'],
    ]);
    const offer = await prisma.makerOffer.findFirstOrThrow({ where: { chainId: CHAIN } });
    expect([offer.backing.toFixed(), offer.fills, offer.active]).toEqual([(9_800n * E6).toString(), 1, true]);
    expect(await prisma.fundingPoint.count({ where: { chainId: CHAIN } })).toBe(1);
    const unknownRow = await prisma.chainEvent.findFirstOrThrow({ where: { chainId: CHAIN, kind: { startsWith: 'unknown:' } } });
    expect(unknownRow.address).toBe(C.vault);
    const activity = await prisma.accountActivity.findMany({ where: { chainId: CHAIN, account: TAKER }, orderBy: [{ block: 'asc' }, { logIndex: 'asc' }] });
    expect(activity.map((a) => a.kind)).toEqual(['deposit', 'position_open', 'position_add_margin', 'position_close', 'position_settled']);
    expect(activity[0]!.data).toMatchObject({ token: 'USDG', amount: '5000' });
    expect(activity.at(-1)!.data).toMatchObject({ role: 'taker', payout: '300', pnl: '100', fee: '0.6' });
    const counts = async () => Promise.all([prisma.chainEvent.count({ where: { chainId: CHAIN } }), prisma.accountActivity.count({ where: { chainId: CHAIN } }), prisma.perpTrade.count({ where: { chainId: CHAIN } })]);
    const before = await counts();

    // A crash after the commit and a replay from an older checkpoint changes nothing.
    await prisma.indexerCheckpoint.update({ where: { chainId_deployment: { chainId: CHAIN, deployment: C.perpsMarkets } }, data: { block: 0n, blockHash: chain.blocks[0]!.hash } });
    await run(ix);
    expect(await counts()).toEqual(before);
    expect((await position())!.takerMargin.toFixed()).toBe((250n * E6).toString());
  });

  it('halves the eth_getLogs range when the provider refuses it', async () => {
    const chain = new FakeChain(40);
    chain.maxRange = 8n;
    chain.append([deposit(TAKER, 1n)]);
    const ix = new Indexer({ client: chain, prisma, deployment: d, chainId: CHAIN, confirmations: 2, chunkBlocks: 32, startBlock: null, log: silent });
    await ix.init();
    await run(ix);
    expect(chain.getLogsCalls.some(([f, t]) => t - f + 1n === 32n)).toBe(true);
    expect(chain.getLogsCalls.every(([f, t]) => t - f + 1n <= 32n)).toBe(true);
    // Confirmations: the head (40) and the block before stay unindexed.
    expect(ix.status().block).toBe(38);
    expect(await prisma.vaultTransfer.count({ where: { chainId: CHAIN } })).toBe(0);
  });

  it('rewinds a reorg to the common ancestor and refolds the state the orphaned blocks touched', async () => {
    const chain = new FakeChain(2);
    chain.append([offerPosted(1n)]); // 2
    chain.append([offerFilled(1n, 1_000n * E6, 9_800n * E6), positionChanged(1n, 0, 200n * E6, 400n * E18)]); // 3
    chain.append([]); // 4
    chain.append([positionChanged(1n, 2, 260n * E6, 0n), deposit(TAKER, 7n)]); // 5 (orphaned below)
    chain.append([]); // 6
    const ix = new Indexer({ client: chain, prisma, deployment: d, chainId: CHAIN, confirmations: 0, chunkBlocks: 100, startBlock: null, log: silent });
    await ix.init();
    await run(ix);
    expect((await position())!.takerMargin.toFixed()).toBe((260n * E6).toString());

    // Another branch from block 5: no margin change, a different deposit, and a longer chain.
    chain.fork(5, 'b', [[deposit(TAKER, 9n)], [], []]);
    await run(ix);
    expect(ix.status().reorgs).toBe(1);
    const p = (await position())!;
    expect(p.takerMargin.toFixed()).toBe((200n * E6).toString());
    expect(p.lastBlock).toBe(3n);
    const transfers = await prisma.vaultTransfer.findMany({ where: { chainId: CHAIN } });
    expect(transfers.map((t) => t.amount.toFixed())).toEqual(['9']);
    const kinds = (await prisma.accountActivity.findMany({ where: { chainId: CHAIN, account: TAKER } })).map((a) => a.kind).sort();
    expect(kinds).toEqual(['deposit', 'position_open']);
    const cp = await prisma.indexerCheckpoint.findUniqueOrThrow({ where: { chainId_deployment: { chainId: CHAIN, deployment: C.perpsMarkets } } });
    expect(cp.blockHash).toBe(chain.blocks[Number(cp.block)]!.hash);

    // A reorg to a shorter chain (ending before the new deposit) is caught while idle too, once a second poll
    // confirms it (L-8).
    chain.fork(5, 'c', []);
    await run(ix);
    expect(ix.status().reorgs).toBe(1);
    await run(ix);
    expect(ix.status().reorgs).toBe(2);
    expect(await prisma.vaultTransfer.count({ where: { chainId: CHAIN } })).toBe(0);
  });

  it('a head below the checkpoint seen once (a lagging node) rewinds nothing; seen twice in a row it does (L-8)', async () => {
    const chain = new FakeChain(2);
    chain.append([deposit(TAKER, 7n)]); // 2
    chain.append([]); // 3
    const ix = new Indexer({ client: chain, prisma, deployment: d, chainId: CHAIN, confirmations: 0, chunkBlocks: 100, startBlock: null, log: silent });
    await ix.init();
    await run(ix);
    chain.laggingHeads = [1n];
    expect(await ix.step()).toBe('idle'); // the lagging answer
    expect(await ix.step()).toBe('idle'); // the real head again: nothing happened
    expect(ix.status().reorgs).toBe(0);
    expect(await prisma.vaultTransfer.count({ where: { chainId: CHAIN } })).toBe(1);
    chain.laggingHeads = [1n, 1n];
    await ix.step();
    expect(await ix.step()).toBe('rewound');
    expect(ix.status().reorgs).toBe(1);
  });

  it('a rewind deletes and rebuilds only this deployment\'s rows, never another deployment\'s on the same chain (L-8)', async () => {
    const chain = new FakeChain(2);
    chain.append([offerPosted(1n)]); // 2
    chain.append([offerFilled(1n, 1_000n * E6, 9_800n * E6), positionChanged(1n, 0, 200n * E6, 400n * E18)]); // 3
    chain.append([positionChanged(1n, 2, 260n * E6, 0n), deposit(TAKER, 7n)]); // 4 (orphaned below)
    chain.append([]); // 5
    const ix = new Indexer({ client: chain, prisma, deployment: d, chainId: CHAIN, confirmations: 0, chunkBlocks: 100, startBlock: null, log: silent });
    await ix.init();
    await run(ix);
    // Rows an earlier deployment on this chain indexed, above the coming ancestor.
    const OLD = { perps: A(905), vault: A(901) };
    await prisma.chainEvent.create({ data: { chainId: CHAIN, kind: 'Deposited', address: OLD.vault, txHash: '0xold1', logIndex: 0, block: 4n, data: {} } });
    await prisma.vaultTransfer.create({ data: { chainId: CHAIN, txHash: '0xold1', logIndex: 0, vault: OLD.vault, kind: 'deposit', from: TAKER, to: TAKER, token: T.USDG, amount: '1', block: 4n, at: new Date(0) } });
    await prisma.accountActivity.create({ data: { chainId: CHAIN, txHash: '0xold1', logIndex: 0, account: TAKER, contract: OLD.vault, kind: 'deposit', data: {}, block: 4n, at: new Date(0) } });
    const old = await prisma.perpPosition.findFirstOrThrow({ where: { chainId: CHAIN, perps: C.perpsMarkets } });
    await prisma.perpPosition.create({ data: { ...old, perps: OLD.perps, lastBlock: 5n } });
    chain.fork(4, 'b', [[], [], []]);
    await run(ix);
    expect(ix.status().reorgs).toBe(1);
    expect((await position())!.takerMargin.toFixed()).toBe((200n * E6).toString());
    expect(await prisma.chainEvent.count({ where: { chainId: CHAIN, address: OLD.vault } })).toBe(1);
    expect(await prisma.vaultTransfer.count({ where: { chainId: CHAIN, vault: OLD.vault } })).toBe(1);
    expect(await prisma.vaultTransfer.count({ where: { chainId: CHAIN, vault: C.vault } })).toBe(0);
    expect(await prisma.accountActivity.count({ where: { chainId: CHAIN, contract: OLD.vault } })).toBe(1);
    expect((await prisma.perpPosition.findFirstOrThrow({ where: { chainId: CHAIN, perps: OLD.perps } })).takerMargin.toFixed()).toBe(old.takerMargin.toFixed());
  });

  it('a single block over the provider log cap is read with eth_getBlockReceipts; its funding points collapse to one (L-2, R5)', async () => {
    const chain = new FakeChain(2);
    chain.maxLogs = 1000;
    chain.append([deposit(TAKER, 1n)]); // 2
    // 3: anyone can call advanceFunding in a loop: 1,200 FundingAdvanced events in one block.
    chain.append(Array.from({ length: 1200 }, (_, i) => funding(BigInt(i + 1))));
    chain.append([deposit(TAKER, 2n)]); // 4
    const lines: string[] = [];
    const log: Logger = { ...silent, info: (m) => void lines.push(m), warn: (m) => void lines.push(m) };
    const ix = new Indexer({ client: chain, prisma, deployment: d, chainId: CHAIN, confirmations: 0, chunkBlocks: 100, startBlock: null, log });
    await ix.init();
    await ix.tick();
    expect(ix.status()).toMatchObject({ block: 4, error: null });
    expect(chain.requests).toContain('eth_getBlockReceipts');
    expect(lines.some((m) => /halving the range/.test(m))).toBe(true);
    expect(await prisma.chainEvent.count({ where: { chainId: CHAIN, kind: 'FundingAdvanced' } })).toBe(1200);
    const points = await prisma.fundingPoint.findMany({ where: { chainId: CHAIN } });
    expect(points.map((p) => [p.block, p.index.toFixed()])).toEqual([[3n, '1200']]);
    expect(await prisma.vaultTransfer.count({ where: { chainId: CHAIN } })).toBe(2);
  });

  it('without eth_getBlockReceipts, reads the block contract by contract, then event by event', async () => {
    const chain = new FakeChain(2);
    chain.maxLogs = 1000;
    chain.receipts = false;
    // perpsMarkets alone is over the cap in this block; each of its events is under it.
    const closeOnly = (on: boolean): EventSpec => ({ address: C.perpsMarkets, abi: abis.perpsMarkets, eventName: 'CloseOnlySet', args: { market: T.TSLA }, data: [{ type: 'bool' }], values: [on] });
    chain.append([deposit(TAKER, 1n), ...Array.from({ length: 600 }, (_, i) => funding(BigInt(i + 1))), ...Array.from({ length: 401 }, (_, i) => closeOnly(i % 2 === 0)), offerPosted(1n)]); // 2
    const ix = new Indexer({ client: chain, prisma, deployment: d, chainId: CHAIN, confirmations: 0, chunkBlocks: 100, startBlock: null, log: silent });
    await ix.init();
    await ix.tick();
    expect(ix.status()).toMatchObject({ block: 2, error: null });
    expect(await prisma.chainEvent.count({ where: { chainId: CHAIN } })).toBe(1003);
    expect(await prisma.fundingPoint.count({ where: { chainId: CHAIN } })).toBe(1);
    expect(await prisma.makerOffer.count({ where: { chainId: CHAIN } })).toBe(1);
    // logIndex order is kept across the per-contract reads.
    const ev = await prisma.chainEvent.findMany({ where: { chainId: CHAIN }, orderBy: { logIndex: 'asc' }, select: { kind: true } });
    expect([ev[0]!.kind, ev.at(-1)!.kind]).toEqual(['Deposited', 'OfferPosted']);
  });
});
