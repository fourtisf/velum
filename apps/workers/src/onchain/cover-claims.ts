/**
 * The shortfall claims the keeper may pay out (claimCover), found on the chain itself (on-chain audit M-2): the
 * CoverClaimFiled events of the deployment's perps engine (eth_getLogs from the deployment's start block, CONFIRMATIONS
 * blocks behind the head) give the (epoch, account) pairs, and the coverClaims(epoch, account) view says which are
 * still unpaid. Nothing comes from the indexer's database, which the app user can write.
 *
 * Reorgs: each scan reads the last REORG_OVERLAP_BLOCKS again, and a pair stays a candidate until the view reads 0,
 * so a claim re-included in another block is still found; a pair that never existed costs one view call.
 * Provider caps: a refused range is halved; a single block still refused is read with eth_getBlockReceipts, or else
 * skipped with an alert (health shows it).
 *
 * The scan position and the open pairs can be kept in a small state file (the signer's own home), so a restart does
 * not read the whole history again; without it the scan starts at the deployment's start block.
 */
import type { Deployment, LowerAddress } from '@velum/config/src/onchain';
import { decodeEventLog, encodeEventTopics, toHex, type Hex, type PublicClient } from 'viem';
import type { Logger } from '../lib/log';
import { abis } from './chain';
import { LOG_CAP_ERROR, describeError, errorText } from './errors';

/** Blocks read again on every scan (reorg margin). */
export const REORG_OVERLAP_BLOCKS = 64n;
/** A scan stops after this long; the next tick goes on. */
const SCAN_BUDGET_MS = 2000;
/** More open pairs than this are never kept (each costs a view call per tick at most COVER_PER_TICK at a time). */
const MAX_PAIRS = 10_000;

export type CoverClient = Pick<PublicClient, 'getBlockNumber' | 'getLogs' | 'readContract'> & { request?: PublicClient['request'] };

export interface CoverState {
  read(): unknown;
  write(v: unknown): void;
}

export interface CoverClaim {
  epoch: bigint;
  account: LowerAddress;
}

interface Saved {
  v: 1;
  deployment: string;
  /** Last block scanned (decimal). */
  cursor: string;
  pairs: Array<[string, string]>;
}

const key = (c: CoverClaim) => `${c.epoch}:${c.account}`;
const TOPIC = encodeEventTopics({ abi: abis.perpsMarkets, eventName: 'CoverClaimFiled' })[0]!;

export class CoverClaims {
  private cursor: bigint;
  private readonly pairs = new Map<string, CoverClaim>();
  private chunk: number;
  private alert: string | null = null;

  constructor(
    private readonly d: { client: CoverClient; deployment: Deployment; confirmations: number; chunkBlocks: number; log: Logger; state?: CoverState; now?: () => number },
  ) {
    this.chunk = Math.max(1, d.chunkBlocks);
    this.cursor = BigInt(Math.max(0, d.deployment.startBlock - 1));
    this.restore();
  }

  private perps(): LowerAddress {
    return this.d.deployment.contracts.perpsMarkets;
  }

  private restore(): void {
    const raw = this.d.state?.read() as Partial<Saved> | null | undefined;
    if (!raw || raw.v !== 1 || raw.deployment !== this.perps() || typeof raw.cursor !== 'string' || !/^\d{1,20}$/.test(raw.cursor) || !Array.isArray(raw.pairs)) return;
    const c = BigInt(raw.cursor);
    if (c > this.cursor) this.cursor = c;
    for (const p of raw.pairs.slice(0, MAX_PAIRS)) {
      if (!Array.isArray(p) || typeof p[0] !== 'string' || typeof p[1] !== 'string' || !/^\d{1,30}$/.test(p[0]) || !/^0x[0-9a-f]{40}$/.test(p[1])) continue;
      const claim = { epoch: BigInt(p[0]), account: p[1] as LowerAddress };
      this.pairs.set(key(claim), claim);
    }
  }

  private save(): void {
    if (!this.d.state) return;
    const v: Saved = { v: 1, deployment: this.perps(), cursor: this.cursor.toString(), pairs: [...this.pairs.values()].map((c) => [c.epoch.toString(), c.account]) };
    try {
      this.d.state.write(v);
    } catch (err) {
      this.d.log.warn('keeper could not save its cover-claim scan state', { err: describeError(err) });
    }
  }

  /** Alerts an operator must act on (a block whose logs could not be read). */
  alerts(): string[] {
    return this.alert ? [this.alert] : [];
  }

  /** Last block scanned (status, tests). */
  get scannedTo(): bigint {
    return this.cursor;
  }

  private add(logs: ReadonlyArray<{ address: string; topics: readonly Hex[]; data: Hex }>): void {
    for (const l of logs) {
      if (l.address.toLowerCase() !== this.perps() || l.topics[0] !== TOPIC) continue;
      try {
        const ev = decodeEventLog({ abi: abis.perpsMarkets, data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: true });
        if (ev.eventName !== 'CoverClaimFiled') continue;
        const c = { epoch: ev.args.epoch, account: ev.args.account.toLowerCase() as LowerAddress };
        if (this.pairs.size < MAX_PAIRS || this.pairs.has(key(c))) this.pairs.set(key(c), c);
      } catch {
        /* not this event */
      }
    }
  }

  /** One block's CoverClaimFiled logs when eth_getLogs refuses even that block (L-2): eth_getBlockReceipts. */
  private async oneBlock(n: bigint): Promise<boolean> {
    if (!this.d.client.request) return false;
    try {
      const receipts = (await this.d.client.request({ method: 'eth_getBlockReceipts' as never, params: [toHex(n)] as never })) as unknown as Array<{ logs: Array<{ address: string; topics: Hex[]; data: Hex }> }> | null;
      if (!Array.isArray(receipts)) return false;
      this.add(receipts.flatMap((r) => r.logs ?? []));
      return true;
    } catch {
      return false;
    }
  }

  /** Reads new CoverClaimFiled logs up to CONFIRMATIONS blocks behind the head, for at most SCAN_BUDGET_MS. */
  async scan(): Promise<void> {
    const now = this.d.now ?? Date.now;
    const until = now() + SCAN_BUDGET_MS;
    const head = await this.d.client.getBlockNumber({ cacheTime: 0 });
    const safe = head - BigInt(this.d.confirmations);
    const floor = BigInt(Math.max(0, this.d.deployment.startBlock));
    if (safe < floor) return;
    let from = this.cursor + 1n - REORG_OVERLAP_BLOCKS;
    if (from < floor) from = floor;
    if (from > safe) from = safe;
    let moved = false;
    while (from <= safe && now() < until) {
      let to = from + BigInt(this.chunk) - 1n;
      if (to > safe) to = safe;
      try {
        const logs = await this.d.client.getLogs({ address: this.perps(), event: abis.perpsMarkets.find((x) => x.type === 'event' && x.name === 'CoverClaimFiled') as never, fromBlock: from, toBlock: to, strict: false });
        this.add(logs as never);
      } catch (err) {
        if (!LOG_CAP_ERROR.test(errorText(err))) throw err;
        if (to > from) {
          this.chunk = Math.max(1, Math.floor(this.chunk / 2));
          continue;
        }
        if (!(await this.oneBlock(from))) {
          this.alert = `keeper could not read the cover claims of block ${from} (the provider refuses it): claims filed there may wait for a payout`;
          this.d.log.error('keeper: one block of cover-claim logs is over the provider cap and eth_getBlockReceipts failed; skipping it', { block: Number(from), err: describeError(err) });
        }
      }
      if (to > this.cursor) this.cursor = to;
      moved = true;
      from = to + 1n;
      if (this.chunk < this.d.chunkBlocks) this.chunk = Math.min(this.d.chunkBlocks, this.chunk * 2);
    }
    if (moved) this.save();
  }

  /**
   * The unpaid claims of ended epochs (`currentEpoch` excluded), oldest epoch first, at most `limit`, confirmed with
   * coverClaims(epoch, account) > 0; pairs the view reads as paid (0) are dropped.
   */
  async due(currentEpoch: bigint, limit: number): Promise<CoverClaim[]> {
    const ended = [...this.pairs.values()].filter((c) => c.epoch < currentEpoch).sort((a, b) => (a.epoch === b.epoch ? (a.account < b.account ? -1 : 1) : a.epoch < b.epoch ? -1 : 1));
    const out: CoverClaim[] = [];
    let dropped = false;
    const step = Math.max(1, limit * 2);
    for (let i = 0; i < ended.length && out.length < limit; i += step) {
      const batch = ended.slice(i, i + step);
      const amounts = await Promise.all(
        batch.map((c) => (this.d.client.readContract({ address: this.perps(), abi: abis.perpsMarkets, functionName: 'coverClaims', args: [c.epoch, c.account] }) as Promise<bigint>).catch(() => null)),
      );
      batch.forEach((c, j) => {
        const a = amounts[j];
        if (a === 0n) {
          this.pairs.delete(key(c));
          dropped = true;
        } else if (a !== null && a !== undefined && out.length < limit) out.push(c);
      });
    }
    if (dropped) this.save();
    return out;
  }
}
