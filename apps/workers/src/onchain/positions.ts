/**
 * The keeper's view of the open positions, read from the chain itself (on-chain audit M-2): position ids are
 * sequential (PerpsMarkets.nextPositionId), so every id below it is read once with getPosition, the open ones are
 * kept in memory, and a slow sweep re-reads every id in turn (closures, forced-exit requests, and anything a reorg
 * changed after it was read). Nothing comes from the indexer's database, which the app user (api + workers) can write:
 * a compromised app user can neither add a candidate nor hide one. Every candidate is still checked on chain
 * (isLiquidatable, then a simulation) before anything is signed.
 *
 * Costs (all reads JSON-RPC batched): per tick one nextPositionId, the new ids (at most MAX_NEW_PER_TICK, so a
 * first start over a long history spreads over a few ticks) and `sweepPerTick` getPosition reads.
 */
import { PERPS_LIMITS, type Deployment } from '@velum/config/src/onchain';
import type { Address, PublicClient } from 'viem';
import { abis } from './chain';

/** New ids read per tick at most (a first start over a long history takes a few ticks). */
export const MAX_NEW_PER_TICK = 2000;

export type PositionsClient = Pick<PublicClient, 'readContract'>;

interface PositionView {
  open: boolean;
  exitRequestedAt: bigint;
}

export interface PositionsRefresh {
  /** Open ids read for the first time in this refresh (check them at once: they may be liquidatable already). */
  fresh: bigint[];
  /** The next `checks` open ids in rotation (the rest follow on later ticks). */
  rotation: bigint[];
  /** Open positions whose forced exit has matured at `blockTime`, oldest request first. */
  forced: bigint[];
}

export class ChainPositions {
  /** Every id up to and including this one has been read at least once. */
  private scanned = 0n;
  /** Open ids and their forced-exit request time (0: none). */
  private readonly open = new Map<bigint, bigint>();
  private rotationAt = 0n;
  private sweepAt = 0n;

  constructor(
    private readonly client: PositionsClient,
    private readonly deployment: Deployment,
    private readonly sweepPerTick = 200,
  ) {}

  private perps(): Address {
    return this.deployment.contracts.perpsMarkets;
  }

  private async read(ids: bigint[]): Promise<Array<PositionView | null>> {
    return Promise.all(
      ids.map(async (id) => {
        try {
          const p = (await this.client.readContract({ address: this.perps(), abi: abis.perpsMarkets, functionName: 'getPosition', args: [id] })) as { open: boolean; exitRequestedAt: bigint | number };
          return { open: p.open === true, exitRequestedAt: BigInt(p.exitRequestedAt ?? 0) };
        } catch {
          return null; // unreadable now: left as it was, read again later
        }
      }),
    );
  }

  private apply(id: bigint, v: PositionView | null): void {
    if (!v) return;
    if (v.open) this.open.set(id, v.exitRequestedAt);
    else this.open.delete(id);
  }

  /** The open ids known now, ascending (tests and status). */
  openIds(): bigint[] {
    return [...this.open.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** Highest id read so far. */
  get scannedTo(): bigint {
    return this.scanned;
  }

  /**
   * One refresh: reads nextPositionId, the ids not read yet (at most MAX_NEW_PER_TICK) and the next `sweepPerTick`
   * ids of the sweep over every id, then returns the candidates: the fresh open ids, the next `checks` open ids in
   * rotation, and the matured forced exits at `blockTime` (seconds).
   */
  async refresh(checks: number, blockTime: bigint): Promise<PositionsRefresh> {
    const next = (await this.client.readContract({ address: this.perps(), abi: abis.perpsMarkets, functionName: 'nextPositionId' })) as bigint;
    const last = next - 1n;
    // A reorg (or a redeploy at the same address) can make the chain's last id lower than ours: forget the ids above.
    if (last < this.scanned) {
      for (const id of this.open.keys()) if (id > last) this.open.delete(id);
      this.scanned = last > 0n ? last : 0n;
    }
    const newIds: bigint[] = [];
    for (let id = this.scanned + 1n; id <= last && newIds.length < MAX_NEW_PER_TICK; id++) newIds.push(id);
    const sweepIds: bigint[] = [];
    if (this.scanned > 0n) {
      const n = BigInt(Math.min(this.sweepPerTick, Number(this.scanned)));
      for (let i = 0n; i < n; i++) {
        this.sweepAt = this.sweepAt >= this.scanned ? 1n : this.sweepAt + 1n;
        sweepIds.push(this.sweepAt);
      }
    }
    const [fresh, swept] = await Promise.all([this.read(newIds), this.read(sweepIds)]);
    newIds.forEach((id, i) => this.apply(id, fresh[i]!));
    sweepIds.forEach((id, i) => this.apply(id, swept[i]!));
    // Advance only over the ids read successfully, in order, so an unreadable one is read again next time.
    for (let i = 0; i < newIds.length && fresh[i] !== null; i++) this.scanned = newIds[i]!;

    const freshOpen = newIds.filter((id, i) => fresh[i]?.open === true);
    const ids = this.openIds();
    const rotation: bigint[] = [];
    if (ids.length) {
      let start = ids.findIndex((id) => id > this.rotationAt);
      if (start < 0) start = 0;
      for (let i = 0; i < Math.min(checks, ids.length); i++) rotation.push(ids[(start + i) % ids.length]!);
      this.rotationAt = rotation.at(-1)!;
    }
    const delay = BigInt(PERPS_LIMITS.forcedExitDelaySeconds);
    const forced = [...this.open.entries()]
      .filter(([, at]) => at > 0n && at + delay <= blockTime)
      .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1))
      .map(([id]) => id);
    const seen = new Set(rotation);
    return { fresh: freshOpen.filter((id) => !seen.has(id)), rotation, forced };
  }
}
