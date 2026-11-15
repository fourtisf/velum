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
    events: [] as Array<{ kind: string; data: unknown }>,
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
      findMany: async () => st.rows,
      findFirst: async () => (st.rows.length ? { positionId: st.rows.reduce((m, r) => (r.positionId > m ? r.positionId : m), 0n) } : null),
    },
    chainEvent: { findMany: async () => st.events },
  };
  const sent: TxRequest[] = [];
  const sender = {
    address: ADDR(77),
    busy: false,
    refused: null as string | null,
    next: { state: 'idle' } as PollResult,
    async poll() {
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
      sent.push(req);
      return { status: 'sent', hash: `0x${'33'.repeat(32)}`, nonce: 0 };
    },
    status() {
      return { enabled: true, address: ADDR(77), sending: true, balanceWei: '1', balanceLow: false, inflight: false, stuck: false, gasCapped: false, lastTx: null, lastConfirmedAt: null, error: null };
    },
  };
  const lines: Array<[string, string]> = [];
  const log: Logger = { debug: () => undefined, info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]) };
  let clock = 1_000_000;
  const make = (ethPriceUsd = 4000n) =>
    new Keeper({ client, sender: sender as unknown as TxSender, prisma: prisma as never, deployment: dep, chainId: 46630, fundingEpochSeconds: 3600, ethPriceUsd, maxFeeWei: 10n ** 9n, log, now: () => clock });
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
  it('liquidates the most underwater position first, including ids the indexer has not reached', async () => {
    const h = harness();
    h.st.rows = [{ positionId: 1n, exitSettleAfter: null }];
    h.st.positions.set(1n, pos(400n * E18, 352n * E18)); // claim 8% of notional
    h.st.positions.set(2n, pos(400n * E18, 335n * E18)); // not indexed yet, 4.5%: urgent and first
    await h.make().tick();
    expect(h.sent.map(h.call)).toEqual(['liquidate:2']);
    expect(h.sent[0]!.label).toBe('liquidate:2');
    expect(h.sent[0]!.gas).toBe(375_000n);
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
    h.st.events = [
      { kind: 'CoverClaimFiled', data: { epoch: '5', account: ADDR(40) } },
      { kind: 'CoverClaimFiled', data: { epoch: '6', account: ADDR(41) } },
      { kind: 'CoverPaid', data: { epoch: '6', account: ADDR(41) } },
      { kind: 'CoverClaimFiled', data: { epoch: '10', account: ADDR(42) } }, // the current epoch: not yet
    ];
    const k = h.make();
    await k.tick();
    expect(h.sent.map(h.call)).toEqual(['settleForcedExit:1']);
    h.st.reverts.add('settleForcedExit:1');
    h.advance(31_000);
    await k.tick();
    expect(h.sent.map(h.call).at(-1)).toBe(`advanceFunding:${TSLA}`);
    h.st.reverts.add(`advanceFunding:${TSLA}`);
    h.advance(31_000);
    await k.tick();
    expect(h.sent.map(h.call).at(-1)).toBe(`claimCover:5,${ADDR(40)}`);
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
