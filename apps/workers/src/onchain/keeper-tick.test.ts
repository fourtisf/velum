/**
 * Keeper.tick with a fake chain and sender: ordering, profitability versus solvency, the other actions. Everything the
 * keeper acts on comes from the chain (on-chain audit M-2): positions from nextPositionId + getPosition, cover claims
 * from CoverClaimFiled logs and the coverClaims view; there is no database in the keeper any more.
 */
import { parseDeployment } from '@velum/config/src/onchain';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Address } from 'viem';
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
  /** Default true. */
  open?: boolean;
  /** Forced-exit request time (s), 0 or absent: none. */
  exitRequestedAt?: bigint;
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
    /** CoverClaimFiled events on chain (block, epoch, account) and the coverClaims view (unpaid amount, 0 once paid). */
    claims: [] as Array<{ block: bigint; epoch: bigint; account: Address; amount: bigint }>,
    head: 100n,
    logsError: null as Error | null,
    getPositionReads: [] as bigint[],
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
          st.getPositionReads.push(id);
          const p = st.positions.get(id);
          if (!p) return { market: '0x0000000000000000000000000000000000000000', open: false, exitRequestedAt: 0n, qty: 0n, takerMargin: 0n, makerMargin: 0n };
          return { market: TSLA, open: p.open ?? true, exitRequestedAt: p.exitRequestedAt ?? 0n, qty: p.qty, takerMargin: p.takerMargin, makerMargin: p.makerMargin };
        }
        case 'coverClaims':
          return st.claims.find((c) => c.epoch === (args![0] as bigint) && c.account.toLowerCase() === String(args![1]).toLowerCase())?.amount ?? 0n;
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
    getBlockNumber: (async () => st.head) as unknown as KeeperClient['getBlockNumber'],
    getLogs: (async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (st.logsError) throw st.logsError;
      return st.claims
        .filter((c) => c.block >= fromBlock && c.block <= toBlock)
        .map((c) => ({
          address: ADDR(5),
          topics: encodeEventTopics({ abi: abis.perpsMarkets, eventName: 'CoverClaimFiled', args: { epoch: c.epoch, account: c.account } }),
          data: encodeAbiParameters([{ type: 'uint256' }], [c.amount]),
        }));
    }) as unknown as KeeperClient['getLogs'],
    estimateContractGas: (async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      const key = `${functionName}:${args.map(String).join(',')}`;
      st.simulations.push(key);
      if (st.reverts.has(key)) throw new Error('execution reverted');
      return st.gas;
    }) as unknown as KeeperClient['estimateContractGas'],
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
    new Keeper({ client, sender: sender as unknown as TxSender, deployment: dep, chainId: 46630, fundingEpochSeconds: 3600, ethPriceUsd, maxFeeWei: 10n ** 9n, confirmations: 0, chunkBlocks: 50, log, now: () => clock, receiptPollMs: 0, tickBudgetMs });
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
  it('liquidates the most underwater position first, read from the chain (no index), then the rest in the same tick', async () => {
    const h = harness();
    h.st.positions.set(1n, pos(400n * E18, 352n * E18)); // claim 8% of notional
    h.st.positions.set(2n, pos(400n * E18, 335n * E18)); // 4.5%: urgent and first
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

  it('settles matured forced exits, advances stale funding, pays cover claims of ended epochs (all found on chain)', async () => {
    const h = harness();
    h.st.next = 3n;
    h.st.blockTs = 1_000_000n;
    // Forced exits mature 7 days after the request (getPosition's exitRequestedAt).
    h.st.positions.set(1n, { ...pos(400n * E18, 380n * E18), liquidatable: false, exitRequestedAt: 300_000n }); // matured
    h.st.positions.set(2n, { ...pos(400n * E18, 380n * E18), liquidatable: false, exitRequestedAt: 900_000n }); // not yet
    h.st.market = [true, 0n, 10n * E18, 0n, 0n, 0n, 1000n];
    h.st.claims = [
      { block: 40n, epoch: 7n, account: ADDR(43), amount: 5n * E6 },
      { block: 20n, epoch: 5n, account: ADDR(40), amount: 3n * E6 },
      { block: 30n, epoch: 6n, account: ADDR(44), amount: 0n }, // paid already: the view reads 0
      { block: 90n, epoch: 10n, account: ADDR(45), amount: 1n * E6 }, // the current epoch: not payable yet
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

  it('reads the positions from the chain: new ids once, then a rotation over the open ones, never all at once', async () => {
    const h = harness();
    h.st.market = [true, 0n, 0n, 0n, 0n, 0n, 0n];
    for (let i = 1n; i <= 5n; i++) h.st.positions.set(i, { ...pos(400n * E18, 380n * E18), liquidatable: false });
    h.st.next = 6n;
    const k = h.make();
    (k as unknown as { d: { maxChecks: number } }).d.maxChecks = 2;
    (k as unknown as { positions: { sweepPerTick: number } }).positions.sweepPerTick = 2;
    const ids = async () => (await (k as unknown as { candidateIds(): Promise<{ ids: bigint[] }> }).candidateIds()).ids;
    // First tick: every id is new (read once with getPosition) and checked; then two open ids a tick, rotating.
    expect(await ids()).toEqual([3n, 4n, 5n, 1n, 2n]);
    expect(await ids()).toEqual([3n, 4n]);
    expect(await ids()).toEqual([5n, 1n]);
    // A position opened since: read once, checked at once.
    h.st.positions.set(6n, { ...pos(400n * E18, 380n * E18), liquidatable: false });
    h.st.next = 7n;
    expect(await ids()).toEqual([6n, 2n, 3n]);
    // The sweep re-reads every id in turn (two a tick here): a closure leaves the rotation.
    h.st.positions.get(4n)!.open = false;
    for (let i = 0; i < 4; i++) await ids();
    expect((k as unknown as { positions: { openIds(): bigint[] } }).positions.openIds()).toEqual([1n, 2n, 3n, 5n, 6n]);
    // Bounded reads: per tick, the new ids plus at most two sweep reads.
    expect(h.st.getPositionReads.length).toBeLessThanOrEqual(6 + 2 * 8);
  });

  it('a failed cover read does not hold up liquidations', async () => {
    const h = harness();
    h.st.next = 2n;
    h.st.market = [true, 0n, 0n, 0n, 0n, 0n, 0n];
    h.st.positions.set(1n, pos(400n * E18, 335n * E18));
    h.st.logsError = new Error('connection refused');
    const k = h.make();
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
