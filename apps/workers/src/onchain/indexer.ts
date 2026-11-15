/**
 * Phase 3 indexer: reads every log of the deployment's contracts from the start block (INDEXER_START_BLOCK,
 * or the deployment file's startBlock), CONFIRMATIONS blocks behind the head, in eth_getLogs ranges of at most
 * INDEXER_CHUNK_BLOCKS (halved when the provider refuses a range), and folds them into Postgres
 * (projections.ts). Each range is one transaction together with its checkpoint, so a crash replays it.
 *
 * Reorgs: the checkpoint stores the hash of the last indexed block. Before a range, the first new block's
 * parent hash must equal it (and while idle, the checkpoint block must still have that hash); otherwise the
 * indexer walks back through the stored hashes of indexed blocks (every block with logs, and the last block
 * of every range) until one matches the chain, deletes everything above that common ancestor and refolds the
 * state it touched. A range whose last block changed hash while it was read is discarded and read again.
 */
import { type Deployment, type IndexerStatus, type LowerAddress, deploymentId } from '@velum/config/src/onchain';
import type { PrismaClient } from '@velum/db';
import type { Hex, PublicClient } from 'viem';
import type { Logger } from '../lib/log';
import { abis } from './chain';
import { contractNames, decodeLog, indexedAddresses, type ChainLogEvent, type RawLog } from './decode';
import { describeError, errorText, throttledWarn } from './errors';
import { applyEvents, rebuildState, type ProjectionContext } from './projections';

export const ZERO_HASH: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';
/** Block hashes older than this many blocks behind the checkpoint are pruned (reorgs never go that deep). */
const KEEP_HASHES_BLOCKS = 50_000n;
/** Stop a tick after this long; the next tick goes on. */
const TICK_BUDGET_MS = 20_000;

export type IndexerClient = Pick<PublicClient, 'getBlockNumber' | 'getBlock' | 'getLogs' | 'readContract'>;

export interface IndexerDeps {
  client: IndexerClient;
  prisma: PrismaClient;
  deployment: Deployment;
  chainId: number;
  confirmations: number;
  chunkBlocks: number;
  /** INDEXER_START_BLOCK, or null for the deployment file's startBlock. */
  startBlock: number | null;
  log: Logger;
  now?: () => number;
}

export type StepResult = 'progress' | 'idle' | 'retry' | 'rewound';

export class Indexer {
  private ctx: ProjectionContext | null = null;
  private readonly names: Map<LowerAddress, string>;
  private readonly addresses: LowerAddress[];
  private readonly key: { chainId: number; deployment: string };
  private chunk: number;
  private head: number | null = null;
  private block: number | null = null;
  private lastRunAt: number | null = null;
  private reorgs = 0;
  private lastError: string | null = null;
  private readonly now: () => number;
  private readonly warn: (msg: string, data?: Record<string, unknown>) => void;

  constructor(private readonly d: IndexerDeps) {
    this.names = contractNames(d.deployment);
    this.addresses = indexedAddresses(d.deployment);
    this.key = { chainId: d.chainId, deployment: deploymentId(d.deployment) };
    this.chunk = d.chunkBlocks;
    this.now = d.now ?? Date.now;
    this.warn = throttledWarn(d.log, 60_000, this.now);
  }

  get startBlock(): number {
    return this.d.startBlock ?? this.d.deployment.startBlock;
  }

  /** Token metadata (stored for the API) and the checkpoint, created at startBlock - 1 the first time. */
  async init(): Promise<void> {
    const { client, prisma, deployment, chainId } = this.d;
    const decimals = new Map<LowerAddress, number>();
    for (const [symbol, address] of Object.entries(deployment.tokens)) {
      const dec = Number(await client.readContract({ address, abi: abis.erc20, functionName: 'decimals' }));
      decimals.set(address, dec);
      await prisma.onchainToken.upsert({ where: { chainId_address: { chainId, address } }, create: { chainId, address, symbol, decimals: dec }, update: { symbol, decimals: dec } });
    }
    const usdgDecimals = decimals.get(deployment.tokens.USDG!) ?? 6;
    this.ctx = {
      chainId,
      deployment,
      symbols: new Map(Object.entries(deployment.tokens).map(([s, a]) => [a, s])),
      decimals,
      usdgDecimals,
      valueScale: 10n ** BigInt(36 - usdgDecimals),
    };
    const cp = await prisma.indexerCheckpoint.findUnique({ where: { chainId_deployment: this.key } });
    if (!cp) {
      const start = BigInt(this.startBlock);
      const before = start - 1n;
      const hash = before >= 0n ? (await client.getBlock({ blockNumber: before })).hash ?? ZERO_HASH : ZERO_HASH;
      await prisma.$transaction([
        prisma.indexerCheckpoint.create({ data: { ...this.key, block: before, blockHash: hash } }),
        ...(before >= 0n ? [prisma.indexedBlock.upsert({ where: { chainId_number: { chainId, number: before } }, create: { chainId, number: before, hash }, update: { hash } })] : []),
      ]);
      this.d.log.info('indexer starting', { chainId, fromBlock: Number(start) });
      this.block = Number(before);
    } else this.block = Number(cp.block);
  }

  /** Index until caught up (or the tick budget is spent). Never throws. */
  async tick(): Promise<void> {
    const started = this.now();
    try {
      if (!this.ctx) await this.init();
      for (;;) {
        const r = await this.step();
        if (r === 'idle' || r === 'retry' || this.now() - started > TICK_BUDGET_MS) break;
      }
      this.lastError = null;
    } catch (err) {
      this.lastError = describeError(err);
      this.warn('indexer tick failed', { err: this.lastError });
    } finally {
      this.lastRunAt = this.now();
    }
  }

  private async hashOf(n: bigint): Promise<Hex | null> {
    try {
      return (await this.d.client.getBlock({ blockNumber: n })).hash ?? null;
    } catch {
      return null;
    }
  }

  /** One range (or a rewind). */
  async step(): Promise<StepResult> {
    const { client, prisma, chainId } = this.d;
    const cp = await prisma.indexerCheckpoint.findUniqueOrThrow({ where: { chainId_deployment: this.key } });
    this.block = Number(cp.block);
    const head = await client.getBlockNumber();
    this.head = Number(head);
    const safe = head - BigInt(this.d.confirmations);
    if (safe <= cp.block) {
      // Idle: the chain may still have replaced the checkpoint block (a reorg to a chain no longer than ours,
      // or a shorter one).
      if (cp.block >= 0n && cp.blockHash !== ZERO_HASH) {
        const h = cp.block <= head ? await this.hashOf(cp.block) : null;
        if (cp.block > head || (h !== null && h !== cp.blockHash)) return this.rewind(cp.block);
      }
      return 'idle';
    }
    const from = cp.block + 1n;
    let to = cp.block + BigInt(this.chunk);
    if (to > safe) to = safe;

    const hFrom = await client.getBlock({ blockNumber: from });
    if (cp.blockHash !== ZERO_HASH && hFrom.parentHash !== cp.blockHash) return this.rewind(cp.block);
    const hTo = to === from ? hFrom : await client.getBlock({ blockNumber: to });

    let logs: RawLog[];
    try {
      logs = (await client.getLogs({ address: this.addresses, fromBlock: from, toBlock: to })) as unknown as RawLog[];
    } catch (err) {
      const text = errorText(err);
      if (this.chunk > 1 && /range|too many|limit|exceed|10000|block range|response size|timeout/.test(text)) {
        this.chunk = Math.max(1, Math.floor(this.chunk / 2));
        this.d.log.info('eth_getLogs range refused; halving the range', { chunkBlocks: this.chunk });
        return 'progress';
      }
      throw err;
    }
    const again = to === from ? hFrom : await client.getBlock({ blockNumber: to });
    if (again.hash !== hTo.hash) return 'retry';

    // Block times (and hashes, to check the logs came from this chain) of the blocks with logs.
    const blocks = new Map<bigint, { hash: Hex; timestamp: bigint }>();
    blocks.set(from, { hash: hFrom.hash!, timestamp: hFrom.timestamp });
    blocks.set(to, { hash: hTo.hash!, timestamp: hTo.timestamp });
    const need = [...new Set(logs.map((l) => l.blockNumber))].filter((n) => !blocks.has(n));
    const headers = await Promise.all(need.map((n) => client.getBlock({ blockNumber: n })));
    headers.forEach((h) => blocks.set(h.number!, { hash: h.hash!, timestamp: h.timestamp }));
    for (const l of logs) if (blocks.get(l.blockNumber)?.hash !== l.blockHash) return 'retry';

    const events: ChainLogEvent[] = logs
      .filter((l) => (l as { removed?: boolean }).removed !== true)
      .map((l) => decodeLog(l, this.names, new Date(Number(blocks.get(l.blockNumber)!.timestamp) * 1000)))
      .sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
    const unknown = events.filter((e) => !e.known).length;
    if (unknown) this.d.log.debug('stored logs no ABI decodes (kept raw)', { count: unknown });

    const hashRows = [...new Set([...events.map((e) => e.block), to])].map((n) => ({ chainId, number: n, hash: blocks.get(n)!.hash }));
    const ctx = this.ctx!;
    await prisma.$transaction(
      async (tx) => {
        // Optimistic lock: another instance (or a rewind) moved the checkpoint meanwhile.
        const moved = await tx.indexerCheckpoint.updateMany({ where: { ...this.key, block: cp.block, blockHash: cp.blockHash }, data: { block: to, blockHash: hTo.hash! } });
        if (moved.count !== 1) throw new Error('indexer checkpoint moved during the range; retrying');
        await applyEvents(tx, ctx, events);
        await tx.indexedBlock.createMany({ data: hashRows, skipDuplicates: true });
        if (to > KEEP_HASHES_BLOCKS) await tx.indexedBlock.deleteMany({ where: { chainId, number: { lt: to - KEEP_HASHES_BLOCKS } } });
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    this.block = Number(to);
    if (this.chunk < this.d.chunkBlocks && logs.length < 1000) this.chunk = Math.min(this.d.chunkBlocks, this.chunk * 2);
    if (events.length) this.d.log.debug('indexed', { from: Number(from), to: Number(to), events: events.length });
    return 'progress';
  }

  /** Finds the common ancestor through the stored block hashes, deletes everything above it and refolds. */
  private async rewind(cpBlock: bigint): Promise<StepResult> {
    const { prisma, chainId } = this.d;
    const floor = BigInt(this.startBlock) - 1n;
    let ancestor: bigint | null = null;
    let ancestorHash: Hex = ZERO_HASH;
    let cursor = cpBlock;
    while (ancestor === null) {
      const rows = await prisma.indexedBlock.findMany({ where: { chainId, number: { lte: cursor, gte: floor } }, orderBy: { number: 'desc' }, take: 50 });
      if (!rows.length) break;
      for (const r of rows) {
        if ((await this.hashOf(r.number)) === r.hash) {
          ancestor = r.number;
          ancestorHash = r.hash as Hex;
          break;
        }
      }
      cursor = rows[rows.length - 1]!.number - 1n;
    }
    if (ancestor === null) {
      ancestor = floor;
      ancestorHash = floor >= 0n ? ((await this.hashOf(floor)) ?? ZERO_HASH) : ZERO_HASH;
    }
    const a = ancestor;
    const ctx = this.ctx!;
    const rebuilt = await prisma.$transaction(
      async (tx) => {
        const gt = { chainId, block: { gt: a } };
        await tx.chainEvent.deleteMany({ where: gt });
        await tx.perpTrade.deleteMany({ where: gt });
        await tx.fundingPoint.deleteMany({ where: gt });
        await tx.spotSwap.deleteMany({ where: gt });
        await tx.spotLiquidity.deleteMany({ where: gt });
        await tx.vaultTransfer.deleteMany({ where: gt });
        await tx.accountActivity.deleteMany({ where: gt });
        await tx.indexedBlock.deleteMany({ where: { chainId, number: { gt: a } } });
        const r = await rebuildState(tx, ctx, a, this.names);
        await tx.indexerCheckpoint.update({ where: { chainId_deployment: this.key }, data: { block: a, blockHash: ancestorHash } });
        return r;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    this.reorgs++;
    this.block = Number(a);
    this.d.log.warn('chain reorganisation: rewound the index to the common ancestor', { from: Number(cpBlock), to: Number(a), rebuilt });
    return 'rewound';
  }

  status(enabled = true): IndexerStatus {
    return {
      enabled,
      block: this.block,
      head: this.head,
      lagBlocks: this.head !== null && this.block !== null ? Math.max(0, this.head - this.block) : null,
      lastRunAt: this.lastRunAt,
      reorgs: this.reorgs,
      error: this.lastError,
    };
  }
}
