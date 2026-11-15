/**
 * Phase 3 indexer: reads every log of the deployment's contracts from the start block (INDEXER_START_BLOCK,
 * or the deployment file's startBlock), CONFIRMATIONS blocks behind the head, in eth_getLogs ranges of at most
 * INDEXER_CHUNK_BLOCKS (halved when the provider refuses a range), and folds them into Postgres
 * (projections.ts). Each range is one transaction together with its checkpoint, so a crash replays it.
 *
 * Reorgs: the checkpoint stores the hash of the last indexed block. Before a range, the first new block's
 * parent hash must equal it (and while idle, the checkpoint block must still have that hash); otherwise the
 * indexer walks back through the stored hashes of indexed blocks (every block with logs, and the last block
 * of every range) until one matches the chain, deletes this deployment's rows above that common ancestor and
 * refolds the state it touched. A mismatch or a head below the checkpoint must be seen on REORG_CONFIRM_POLLS
 * consecutive polls first (a load-balanced RPC may answer once from a node that lags), and the rewind only touches
 * the deployment's own contracts (audit L-8). A range whose last block changed hash while it was read is
 * discarded and read again.
 *
 * Provider log caps (audit L-2): a range the provider refuses is halved; a single block it still refuses (anyone
 * can fill one with permissionless events, e.g. advanceFunding in a loop) is read with eth_getBlockReceipts, or
 * else contract by contract and, for a contract still over the cap, event by event.
 */
import { type Deployment, type IndexerStatus, type LowerAddress, deploymentId } from '@velum/config/src/onchain';
import type { PrismaClient } from '@velum/db';
import { toHex, type Abi, type AbiEvent, type Hex, type PublicClient } from 'viem';
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
/** Consecutive polls that must see a reorg (hash mismatch, head below the checkpoint) before the index rewinds. */
export const REORG_CONFIRM_POLLS = 2;

/**
 * Provider texts for "this eth_getLogs asks for too much" (block range or result count): geth/Nitro, Alchemy,
 * Infura, QuickNode, Ankr, Chainstack, BlastAPI, dRPC and others, plus the JSON-RPC codes some of them use.
 */
export const LOG_CAP_ERROR =
  /range|too many|limit|exceed|10000|10,000|response size|too big|too large|timeout|timed out|max(imum)? (number of )?(results|logs)|query returned more than|logs matched|result window|-32005|-32602|-32011/;

export type IndexerClient = Pick<PublicClient, 'getBlockNumber' | 'getBlock' | 'getLogs' | 'readContract'> & {
  /** eth_getBlockReceipts for one block (any viem client); used only when a single block's logs exceed the cap. */
  request?: PublicClient['request'];
};

interface RpcReceiptLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  removed?: boolean;
}

const CONTRACT_ABIS: Record<string, Abi> = {
  vault: abis.vault,
  oracle: abis.oracle,
  spotPools: abis.spotPools,
  makerBook: abis.makerBook,
  perpsMarkets: abis.perpsMarkets,
};

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
  private okAt: number | null = null;
  /** Consecutive polls that saw a reorg at the checkpoint (REORG_CONFIRM_POLLS needed to rewind). */
  private suspect: { block: bigint; polls: number } | null = null;
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

  /** Unix ms of the last tick that ran to the end without an error (audit M-3). */
  get lastOkAt(): number | null {
    return this.okAt;
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
      this.okAt = this.now();
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
        if (cp.block > head || (h !== null && h !== cp.blockHash)) return this.suspectReorg(cp.block, 'idle');
      }
      this.suspect = null;
      return 'idle';
    }
    const from = cp.block + 1n;
    let to = cp.block + BigInt(this.chunk);
    if (to > safe) to = safe;

    const hFrom = await client.getBlock({ blockNumber: from });
    if (cp.blockHash !== ZERO_HASH && hFrom.parentHash !== cp.blockHash) return this.suspectReorg(cp.block, 'retry');
    this.suspect = null;
    const hTo = to === from ? hFrom : await client.getBlock({ blockNumber: to });

    let logs: RawLog[];
    try {
      logs = (await client.getLogs({ address: this.addresses, fromBlock: from, toBlock: to })) as unknown as RawLog[];
    } catch (err) {
      if (!LOG_CAP_ERROR.test(errorText(err))) throw err;
      if (this.chunk > 1 && to > from) {
        this.chunk = Math.max(1, Math.floor(this.chunk / 2));
        this.d.log.info('eth_getLogs range refused; halving the range', { chunkBlocks: this.chunk });
        return 'progress';
      }
      // One block over the provider's cap: read it another way, never stall on it (L-2).
      this.d.log.warn('eth_getLogs refused a single block; reading it without the cap', { block: Number(from), err: describeError(err) });
      logs = await this.singleBlockLogs(from);
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

  /**
   * A reorg seen at the checkpoint: rewind once it was seen on REORG_CONFIRM_POLLS consecutive polls (L-8), else wait
   * (`wait`: what this step reports meanwhile).
   */
  private async suspectReorg(cpBlock: bigint, wait: 'idle' | 'retry'): Promise<StepResult> {
    const polls = this.suspect?.block === cpBlock ? this.suspect.polls + 1 : 1;
    this.suspect = { block: cpBlock, polls };
    if (polls < REORG_CONFIRM_POLLS) {
      this.d.log.info('possible chain reorganisation at the checkpoint; checking again before rewinding', { block: Number(cpBlock), polls });
      return wait;
    }
    this.suspect = null;
    return this.rewind(cpBlock);
  }

  /**
   * Every log of the deployment's contracts in block `n`, for a block whose logs exceed the provider's eth_getLogs
   * cap (L-2): eth_getBlockReceipts (no cap), or else one eth_getLogs per contract and, for a contract still over the
   * cap, one per known event (logs of events no ABI here knows are then not seen in that block: logged).
   */
  private async singleBlockLogs(n: bigint): Promise<RawLog[]> {
    const { client } = this.d;
    const mine = new Set<string>(this.addresses);
    if (client.request) {
      try {
        const receipts = (await client.request({ method: 'eth_getBlockReceipts', params: [toHex(n)] } as never)) as Array<{ logs: RpcReceiptLog[] }> | null;
        if (Array.isArray(receipts)) {
          return receipts
            .flatMap((r) => r.logs ?? [])
            .filter((l) => mine.has(l.address.toLowerCase()) && l.removed !== true)
            .map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: BigInt(l.blockNumber), blockHash: l.blockHash, transactionHash: l.transactionHash, logIndex: Number(l.logIndex) }));
        }
      } catch (err) {
        this.d.log.info('eth_getBlockReceipts unavailable; reading the block contract by contract', { block: Number(n), err: describeError(err) });
      }
    }
    const out: RawLog[] = [];
    for (const address of this.addresses) {
      try {
        out.push(...((await client.getLogs({ address, fromBlock: n, toBlock: n })) as unknown as RawLog[]));
      } catch (err) {
        if (!LOG_CAP_ERROR.test(errorText(err))) throw err;
        const abi = CONTRACT_ABIS[this.names.get(address) ?? ''];
        if (!abi) throw err;
        this.d.log.warn('one contract\'s logs in one block exceed the provider cap; reading them event by event (unknown events of this block are skipped)', { block: Number(n), address });
        for (const event of abi.filter((x): x is AbiEvent => x.type === 'event')) {
          out.push(...((await client.getLogs({ address, event, fromBlock: n, toBlock: n, strict: false })) as unknown as RawLog[]));
        }
      }
    }
    return out;
  }

  /**
   * Finds the common ancestor through the stored block hashes, deletes this deployment's rows above it (L-8: never
   * another deployment's on the same chain) and refolds the state it touched.
   */
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
    const { perpsMarkets: perps, spotPools: pools, vault } = this.d.deployment.contracts;
    const rebuilt = await prisma.$transaction(
      async (tx) => {
        // Only this deployment's rows: another deployment on the same chain keeps its own (L-8). The block hashes
        // are the chain's, wrong above the ancestor for every reader.
        const gt = { chainId, block: { gt: a } };
        await tx.chainEvent.deleteMany({ where: { ...gt, address: { in: this.addresses } } });
        await tx.perpTrade.deleteMany({ where: { ...gt, perps } });
        await tx.fundingPoint.deleteMany({ where: { ...gt, perps } });
        await tx.spotSwap.deleteMany({ where: { ...gt, pools } });
        await tx.spotLiquidity.deleteMany({ where: { ...gt, pools } });
        await tx.vaultTransfer.deleteMany({ where: { ...gt, vault } });
        await tx.accountActivity.deleteMany({ where: { ...gt, contract: { in: this.addresses } } });
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
