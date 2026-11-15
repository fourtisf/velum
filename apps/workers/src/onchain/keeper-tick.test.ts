/** Keeper.tick with a fake chain, index and sender: ordering, profitability versus solvency, the other actions. */
import { parseDeployment } from '@velum/config/src/onchain';
import { decodeFunctionData, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../lib/log';
import { abis } from './chain';
import { Keeper, type KeeperClient } from './keeper';
import type { PollResult, SubmitResult, TxRequest, TxSender } from './tx-sender';

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const VALUE_SCALE = 10n ** 30n;
const ADDR = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const TSLA = ADDR(11);
const dep = (() => {
  const r = parseDeployment({ chainId: 46630, startBlock: 1, contracts: { vault: ADDR(1), oracle: ADDR(2), spotPools: ADDR(3), makerBook: ADDR(4), perpsMarkets: ADDR(5) }, tokens: { USDG: ADDR(10), TSLA }, priceRelayer: ADDR(9) }, 46630);
  if (!r.ok) throw new Error(r.error);
  return r.deployment;
})();

interface Pos {
  qty: bigint;
  takerMargin: bigint;
  makerMargin: bigint;
  claim: bigint;
  liquidatable: boolean;
}

function harness() {
  const st = {
    price: 352n * E18,
    next: 3n,
    positions: new Map<bigint, Pos>(),
    market: [true, 0n, 10n * E18, 0n, 0n, 0n, 0n] as readonly [boolean, bigint, bigint, bigint, bigint, bigint, bigint],
    blockTs: 10_000n,
    reverts: new Set<string>(),
    gas: 300_000n,
    simulations: [] as string[],
    rows: [] as Array<{ positionId: bigint; exitSettleAfter: Date | null }>,
    /** What the unpaid-cover-claims SQL returns (its own test runs against Postgres: keeper-db.test.ts). */
    cover: [] as Array<{ epoch: string; account: string }>,
    pageReads: [] as unknown[],
  };
  const client: KeeperClient = {
    readContract: (async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      const id = args?.[0] as bigint;
      switch (functionName) {
        case 'valueScale':
          return VALUE_SCALE;
        case 'keeperRewardCap':
          return E6;
        case 'decimals':
          return 6;
        case 'nextPositionId':
          return st.next;
        case 'sequencerStatus':
          return [true, true];
        case 'isLiquidatable':
          return st.positions.get(id)?.liquidatable ?? false;
        case 'insurance':
          return 1000n * E6;
        case 'getPosition': {
          const p = st.positions.get(id)!;
          return { market: TSLA, qty: p.qty, takerMargin: p.takerMargin, makerMargin: p.makerMargin };
        }
        case 'price':
          return st.price;
        case 'takerClaimAt':
          return st.positions.get(id)!.claim;
        case 'markets':
          return st.market;
        case 'currentCoverEpoch':
          return 10n;
      }
      throw new Error(`unexpected ${functionName}`);
    }) as unknown as KeeperClient['readContract'],
    getBlock: (async () => ({ timestamp: st.blockTs })) as unknown as KeeperClient['getBlock'],
    estimateContractGas: (async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      const key = `${functionName}:${args.map(String).join(',')}`;
      st.simulations.push(key);
      if (st.reverts.has(key)) throw new Error('execution reverted');
      return st.gas;
    }) as unknown as KeeperClient['estimateContractGas'],
  };
  const prisma = {
    perpPosition: {
      // The keeper's two reads: keyset pages of open positions by id, and matured forced exits.
      findMany: async ({ where, take }: { where: { positionId?: { gt?: bigint; lte?: bigint }; exitSettleAfter?: { lte: Date } }; take: number }) => {
        st.pageReads.push(where.positionId ?? null);
        const rows = st.rows
          .filter((r) => (where.positionId?.gt === undefined || r.positionId > where.positionId.gt) && (where.positionId?.lte === undefined || r.positionId <= where.positionId.lte))
          .filter((r) => !where.exitSettleAfter || (r.exitSettleAfter !== null && r.exitSettleAfter <= where.exitSettleAfter.lte))
          .sort((x, y) => (x.positionId < y.positionId ? -1 : 1));
        return rows.slice(0, take);
      },
      findFirst: async () => (st.rows.length ? { positionId: st.rows.reduce((m, r) => (r.positionId > m ? r.positionId : m), 0n) } : null),
    },
    $queryRaw: async () => st.cover,
  };
  const sent: TxRequest[] = [];
  // One transaction in flight, like TxSender: busy from submit until a poll reports it mined (at once, unless `hold`).
  const sender = {
    address: ADDR(77),
    busy: false,
    hold: false,
    polls: 0,
    inflight: null as string | null,
    refused: null as string | null,
    next: { state: 'idle' } as PollResult,
    async poll(): Promise<PollResult> {
      this.polls++;
      if (this.inflight && !this.hold) {
        const label = this.inflight;
        this.inflight = null;
        this.busy = false;
        return { state: 'mined', label, receipt: { status: 'success', blockNumber: 1n, transactionHash: `0x${'33'.repeat(32)}`, gasUsed: 1n, logs: [] } };
      }
      const p = this.next;
      this.next = { state: 'idle' };
      return p;
    },
    refusal() {
      return this.refused;
    },
    async feeQuote() {
      return 10n ** 8n; // 0.1 gwei
    },
    async submit(req: TxRequest): Promise<SubmitResult> {
      if (this.busy) return { status: 'busy' };
      sent.push(req);
      this.busy = true;
      this.inflight = req.label;
      return { status: 'sent', hash: `0x${'33'.repeat(32)}`, nonce: 0 };
    },
    status() {
      return { enabled: true, address: ADDR(77), sending: true, balanceWei: '1', balanceLow: false, inflight: false, stuck: false, gasCapped: false, lastTx: null, lastConfirmedAt: null, error: null };
    },
  };
  const lines: Array<[string, string]> = [];
  const log: Logger = { debug: () => undefined, info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]) };
  let clock = 1_000_000;
  const make = (ethPriceUsd = 4000n, tickBudgetMs?: number) =>
    new Keeper({ client, sender: sender as unknown as TxSender, prisma: prisma as never, deployment: dep, chainId: 46630, fundingEpochSeconds: 3600, ethPriceUsd, maxFeeWei: 10n ** 9n, log, now: () => clock, receiptPollMs: 0, tickBudgetMs });
  const call = (r: TxRequest) => {
    const d = decodeFunctionData({ abi: abis.perpsMarkets, data: r.data });
    return `${d.functionName}:${((d.args ?? []) as readonly unknown[]).map(String).join(',')}`;
  };
  return { st, sent, sender, lines, make, call, advance: (ms: number) => (clock += ms) };
}

const pos = (entry: bigint, price: bigint, margin = 200n * E6): Pos => {
  const qty = (1000n * E6 * VALUE_SCALE) / entry;
  return { qty, takerMargin: margin, makerMargin: 200n * E6, claim: margin + (qty * (price - entry)) / VALUE_SCALE, liquidatable: true };
};

describe('Keeper.tick', () => {
  it('liquidates the most underwater position first, including ids the indexer has not reached, then the rest in the same tick', async () => {
    const h = harness();
    h.st.rows = [{ positionId: 1n, exitSettleAfter: null }];
    h.st.positions.set(1n, pos(400n * E18, 352n * E18)); // claim 8% of notional
    h.st.positions.set(2n, pos(400n * E18, 335n * E18)); // not indexed yet, 4.5%: urgent and first
    const k = h.make();
    await k.tick();
    // L-3: one transaction in flight, but the next action follows as soon as the previous one mined.
    expect(h.sent.map(h.call)).toEqual(['liquidate:2', 'liquidate:1', `advanceFunding:${TSLA}`]);
    expect(h.sent[0]!.label).toBe('liquidate:2');
    expect(h.sent[0]!.gas).toBe(375_000n);
    expect(k.status().liquidations).toBe(2);
    expect(k.lastOkAt).not.toBeNull();
  });

  it('works through many liquidatable positions in one tick by risk, within the tick budget (L-3)', async () => {
    const h = harness();
    h.st.market = [true, 0n, 0n, 0n, 0n, 0n, 0n];
    h.st.next = 41n;
    // 40 positions whose claims fall as the id grows (7.5% of notional down to below zero): the urgent ones (below
    // MM / 2) first, the most underwater first.
    for (let i = 1n; i <= 40n; i++) h.st.positions.set(i, pos(400n * E18, 350n * E18 - i * 4n * E18));
    const k = h.make();
    await k.tick();
    const ids = h.sent.map((r) => Number(h.call(r).split(':')[1]));
    expect(ids).toHaveLength(40);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(k.status().liquidations).toBe(40);
    // A block that does not come within the budget leaves the rest to the next tick.
    const slow = harness();
    slow.st.market = [true, 0n, 0n, 0n, 0n, 0n, 0n];
    slow.st.next = 4n;
    for (let i = 1n; i <= 3n; i++) slow.st.positions.set(i, pos(400n * E18, 340n * E18));
    slow.sender.hold = true;
    const poll = slow.sender.poll.bind(slow.sender);
    slow.sender.poll = async () => {
      slow.advance(20); // each receipt poll takes 20 ms of the 50 ms budget
      return poll();
    };
    const k2 = slow.make(4000n, 50);
    await k2.tick();
    expect(slow.sent).toHaveLength(1);
    expect(slow.sender.polls).toBeGreaterThan(1); // polled the receipt until the budget ran out
  });

  it('waits on a liquidation worth less than its gas unless solvency needs it', async () => {
    const h = harness();
    h.st.rows = [{ positionId: 1n, exitSettleAfter: null }];
    h.st.next = 2n;
    h.st.positions.set(1n, pos(400n * E18, 352n * E18)); // reward 4.4 USDG
    h.st.market = [true, 0n, 0n, 0n, 0n, 0n, 0n]; // no funding call in the way
    const k = h.make(1_000_000n); // 300k gas x 0.1 gwei at 1M USD per ETH = 30 USDG
    await k.tick();
    expect(h.sent).toHaveLength(0);
    expect(h.lines.filter(([, m]) => /not worth its gas/.test(m))).toHaveLength(1);
    h.advance(20_000);
    await k.tick();
    expect(h.lines.filter(([, m]) => /not worth its gas/.test(m))).toHaveLength(1); // logged once
    h.st.positions.set(1n, pos(400n * E18, 335n * E18)); // now below MM / 2
    h.advance(20_000);
    await k.tick();
    expect(h.sent.map(h.call)).toEqual(['liquidate:1']);
    expect(h.lines.some(([l, m]) => l === 'warn' && /gas loss: needed for solvency/.test(m))).toBe(true);
  });

  it('settles matured forced exits, advances stale funding, pays cover claims of ended epochs', async () => {
    const h = harness();
    h.st.next = 3n;
    h.st.rows = [
      { positionId: 1n, exitSettleAfter: new Date(9_000_000) }, // matured (block time 10,000 s)
      { positionId: 2n, exitSettleAfter: new Date(20_000_000) },
    ];
    h.st.market = [true, 0n, 10n * E18, 0n, 0n, 0n, 1000n];
    h.st.cover = [
      { epoch: '7', account: ADDR(43) },
      { epoch: '5', account: ADDR(40) },
      { epoch: 'x', account: ADDR(44) }, // malformed rows are ignored
    ];
    const k = h.make();
    await k.tick();
    expect(h.sent.map(h.call)).toEqual(['settleForcedExit:1', `advanceFunding:${TSLA}`, `claimCover:5,${ADDR(40)}`, `claimCover:7,${ADDR(43)}`]);
    expect(k.status()).toMatchObject({ forcedExits: 1, fundingAdvances: 1, coverPayouts: 2 });
    // Sent actions cool down: the next tick does not repeat them.
    h.advance(5_000);
    await k.tick();
    expect(h.sent).toHaveLength(4);
  });

  it('reads open positions page by page and rotates through them, never all at once (L-9)', async () => {
    const h = harness();
    h.st.market = [true, 0n, 0n, 0n, 0n, 0n, 0n];
    h.st.rows = Array.from({ length: 5 }, (_, i) => ({ positionId: BigInt(i + 1), exitSettleAfter: null }));
    h.st.next = 6n;
    // Each tick reads one page of two, then wraps around.
    const k = h.make();
    (k as unknown as { d: { maxChecks: number } }).d.maxChecks = 2;
    const ids = async () => (await (k as unknown as { candidateIds(): Promise<{ ids: bigint[] }> }).candidateIds()).ids;
    expect(await ids()).toEqual([1n, 2n]);
    expect(await ids()).toEqual([3n, 4n]);
    expect(await ids()).toEqual([5n, 1n]);
    expect(await ids()).toEqual([2n, 3n]);
    // Never an unbounded read: every position query is a keyset page (or the matured forced exits).
    expect(h.st.pageReads.filter((w) => w === null)).toHaveLength(4); // one forced-exit query per tick
  });

  it('a failed cover read does not hold up liquidations', async () => {
    const h = harness();
    h.st.next = 2n;
    h.st.market = [true, 0n, 0n, 0n, 0n, 0n, 0n];
    h.st.positions.set(1n, pos(400n * E18, 335n * E18));
    (h as unknown as { st: { cover: unknown } }).st.cover = null as never;
    const k = h.make();
    (k as unknown as { d: { prisma: { $queryRaw: () => Promise<never> } } }).d.prisma.$queryRaw = async () => {
      throw new Error('relation "ChainEvent" does not exist');
    };
    await k.tick();
    expect(h.sent.map(h.call)).toEqual(['liquidate:1']);
    expect(h.lines.some(([l, m]) => l === 'warn' && /could not read its cover claims/.test(m))).toBe(true);
  });

  it('cools down after a refused simulation, skips markets without open interest, does nothing while the sender refuses', async () => {
    const h = harness();
    h.st.next = 1n;
    h.st.market = [true, 0n, 0n, 0n, 0n, 0n, 0n]; // no open interest: no funding call
    const k = h.make();
    await k.tick();
    expect(h.st.simulations).toEqual([]);
    h.st.market = [true, 0n, 10n * E18, 0n, 0n, 0n, 0n];
    h.st.reverts.add(`advanceFunding:${TSLA}`); // e.g. StalePrice
    await k.tick();
    expect(h.st.simulations).toEqual([`advanceFunding:${TSLA}`]);
    h.advance(5_000);
    await k.tick();
    expect(h.st.simulations).toHaveLength(1); // cooling down
    h.advance(11_000);
    await k.tick();
    expect(h.st.simulations).toHaveLength(2);
    h.sender.refused = 'Robinhood Chain mainnet: transactions need ONCHAIN_MAINNET_CONFIRMED=yes';
    h.st.reverts.clear();
    h.advance(20_000);
    await k.tick();
    expect(h.st.simulations).toHaveLength(2);
    expect(h.sent).toHaveLength(0);
  });

  it('counts confirmed actions only', async () => {
    const h = harness();
    h.st.next = 1n;
    const k = h.make();
    h.sender.next = { state: 'mined', label: 'liquidate:4', receipt: { status: 'success', blockNumber: 1n, transactionHash: `0x${'44'.repeat(32)}`, gasUsed: 1n, logs: [] } };
    await k.tick();
    h.sender.next = { state: 'mined', label: 'forced_exit:5', receipt: { status: 'reverted', blockNumber: 1n, transactionHash: `0x${'45'.repeat(32)}`, gasUsed: 1n, logs: [] } };
    await k.tick();
    expect(k.status()).toMatchObject({ liquidations: 1, forcedExits: 0 });
  });
});
