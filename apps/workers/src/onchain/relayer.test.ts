import { TOKENS, type MarketSnapshot } from '@velum/config';
import { parseDeployment, type Deployment } from '@velum/config/src/onchain';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../lib/log';
import { abis } from './chain';
import { PriceRelayer, snapshotEligibility, type RelayClient, type RelayerDeps } from './relayer';
import type { PollResult, SubmitResult, TxRequest, TxSender } from './tx-sender';

const E18 = 10n ** 18n;
// Monday 2026-11-16 15:00 UTC (10:00 ET, session open) and the Sunday before (closed).
const OPEN = Date.UTC(2026, 10, 16, 15, 0, 0);
const SUNDAY = Date.UTC(2026, 10, 15, 12, 0, 0);
const RELAYER = '0x00000000000000000000000000000000000000aa' as Address;
const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const silent: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const snap = (symbol: string, price: string, at: number, extra: Partial<MarketSnapshot> = {}): MarketSnapshot => ({ symbol, price, mark: price, open24h: price, spark: [price], source: 'robinhood', updatedAt: at, checkedAt: at, ...extra });

describe('snapshot eligibility', () => {
  it('only a confirmed, recent, real-source quote in an open session', () => {
    expect(snapshotEligibility(undefined, OPEN)).toEqual({ ok: false, reason: 'no-snapshot' });
    expect(snapshotEligibility(snap('TSLA', '391.65', OPEN, { source: 'demo' }), OPEN)).toEqual({ ok: false, reason: 'demo' });
    expect(snapshotEligibility(snap('TSLA', '391.65', OPEN - 11_000), OPEN)).toEqual({ ok: false, reason: 'stale' });
    expect(snapshotEligibility(snap('TSLA', '391.65', OPEN, { unconfirmed: true }), OPEN)).toEqual({ ok: false, reason: 'unconfirmed' });
    expect(snapshotEligibility(snap('TSLA', '391.65', OPEN - 16 * 60_000, { checkedAt: OPEN }), OPEN)).toEqual({ ok: false, reason: 'frozen' });
    expect(snapshotEligibility(snap('TSLA', '391.65', SUNDAY), SUNDAY)).toEqual({ ok: false, reason: 'closed' });
    expect(snapshotEligibility(snap('TSLA', '391.65', OPEN), OPEN)).toEqual({ ok: true, price: 39165n * 10n ** 16n });
    expect(snapshotEligibility(snap('TSLA', '391.65', OPEN, { source: 'chainlink' }), OPEN)).toMatchObject({ ok: true });
  });
});

interface MarketState {
  relayed: [bigint, bigint, bigint];
  band: [bigint, bigint, bigint];
  bounds?: [bigint, bigint];
  feed?: Address;
}

class FakeChain {
  relayer: Address = RELAYER;
  sequencer: [boolean, boolean] = [true, true];
  block = { number: 100n, timestamp: 1_000_000n };
  markets = new Map<string, MarketState>();
  client: RelayClient = {
    readContract: (async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      const m = args ? this.markets.get(String(args[0]).toLowerCase()) : undefined;
      switch (functionName) {
        case 'relayer':
          return this.relayer;
        case 'sequencerStatus':
          return this.sequencer;
        case 'sources':
          return [m?.feed ?? '0x0000000000000000000000000000000000000000', 0, m?.bounds?.[0] ?? E18, m?.bounds?.[1] ?? 100_000n * E18, true];
        case 'relayed':
          return m!.relayed;
        case 'bands':
          return m!.band;
      }
      throw new Error(`unexpected ${functionName}`);
    }) as unknown as RelayClient['readContract'],
    getBlock: (async () => this.block) as unknown as RelayClient['getBlock'],
    estimateGas: (async (a: { to: Address; account: Address }) => {
      this.estimates.push({ to: a.to, account: a.account });
      return 25_000n;
    }) as unknown as RelayClient['estimateGas'],
  };
  estimates: Array<{ to: Address; account: Address }> = [];
}

class FakeSender {
  address = RELAYER;
  busy = false;
  submitted: Array<{ req: TxRequest; rebuild?: () => Promise<TxRequest | null> }> = [];
  next: PollResult = { state: 'idle' };
  async poll(): Promise<PollResult> {
    const p = this.next;
    this.next = { state: 'idle' };
    return p;
  }
  async submit(req: TxRequest, rebuild?: () => Promise<TxRequest | null>): Promise<SubmitResult> {
    this.submitted.push({ req, rebuild });
    return { status: 'sent', hash: `0x${'11'.repeat(32)}`, nonce: 0 };
  }
  status() {
    return { enabled: true, address: RELAYER, sending: true, balanceWei: '1', balanceLow: false, inflight: false, stuck: false, gasCapped: false, lastTx: null, lastConfirmedAt: null, error: null };
  }
}

function setup(chainId: number, tokens: Record<string, Address>, snaps: MarketSnapshot[], clock = OPEN) {
  const r = parseDeployment({ chainId, startBlock: 1, contracts: { vault: A(1), oracle: A(2), spotPools: A(3), makerBook: A(4), perpsMarkets: A(5) }, tokens: { USDG: A(10), ...tokens }, priceRelayer: RELAYER }, chainId);
  if (!r.ok) throw new Error(r.error);
  const d: Deployment = r.deployment;
  const chain = new FakeChain();
  const sender = new FakeSender();
  // The signer's own price feed (signer/prices.ts) in memory: the relayer reads nothing else.
  const store = new Map(snaps.map((s) => [s.symbol, s]));
  const prices: RelayerDeps['prices'] = { snapshots: async (symbols) => new Map(symbols.filter((x) => store.has(x)).map((x) => [x, store.get(x)!])) };
  let wall = Number(chain.block.timestamp) * 1000;
  const relayer = new PriceRelayer({ client: chain.client, sender: sender as unknown as TxSender, prices, deployment: d, chainId, intervalMs: 9000, log: silent, now: () => clock, wallNow: () => wall });
  return { d, chain, sender, relayer, store, setWall: (ms: number) => (wall = ms), seal: (s: MarketSnapshot) => store.set(s.symbol, s) };
}

const pushed = (req: TxRequest) => decodeFunctionData({ abi: abis.oracle, data: req.data }).args as unknown as readonly [readonly Address[], readonly bigint[], bigint];

describe('PriceRelayer', () => {
  it('pushes every qualifying market in one batch, never a demo or stale price; an out-of-bounds one raw, with an alert', async () => {
    const t = setup(31337, { TSLA: A(11), AMZN: A(12), PLTR: A(13), NFLX: A(14) }, [snap('TSLA', '391.65', OPEN), snap('AMZN', '233.40', OPEN, { source: 'demo' }), snap('PLTR', '0.5', OPEN), snap('NFLX', '112.30', OPEN - 20_000)]);
    for (const a of [A(11), A(12), A(13), A(14)]) t.chain.markets.set(a, { relayed: [0n, 0n, 0n], band: [0n, 0n, 0n] });
    await t.relayer.tick();
    expect(t.sender.submitted).toHaveLength(1);
    const [tokens, prices, observedAt] = pushed(t.sender.submitted[0]!.req);
    expect(tokens.map((x) => x.toLowerCase())).toEqual([A(13), A(11)]);
    // L-7: the out-of-bounds PLTR quote (bounds 1-100,000) is pushed as it is; the adapter clamps it.
    expect(prices).toEqual([5n * 10n ** 17n, 39165n * 10n ** 16n]);
    // M-1: the chain clock (1,000,000) minus the snapshots' age (0 s) and one second of margin.
    expect(observedAt).toBe(999_999n);
    // L-4: eth_estimateGas of the calldata sent to the relay itself (25,000 + 25%) plus the execution bound.
    expect(t.chain.estimates).toEqual([{ to: RELAYER, account: RELAYER }]);
    expect(t.sender.submitted[0]!.req.gas).toBe(31_250n + 25_000n + 2n * 60_000n);
    expect(t.relayer.status().markets).toMatchObject({ AMZN: 'demo', PLTR: 'bounds', NFLX: 'stale' });
    expect(t.relayer.status().alerts).toEqual([expect.stringMatching(/^PLTR quote 0\.5 is outside the oracle bounds \[1, 100000\]/)]);
    // Back inside the bounds: the alert ends.
    t.seal(snap('PLTR', '2', OPEN + 1));
    await t.relayer.plan();
    expect(t.relayer.status().alerts).toEqual([]);
  });

  it('stamps the batch with its oldest snapshot, never pushes a snapshot twice or an older one (M-1, L-6)', async () => {
    let clock = OPEN;
    const t = setup(31337, { TSLA: A(11), AMZN: A(12) }, [snap('TSLA', '391.65', OPEN - 1500), snap('AMZN', '233.40', OPEN - 3200)]);
    for (const a of [A(11), A(12)]) t.chain.markets.set(a, { relayed: [0n, 0n, 0n], band: [0n, 0n, 0n] });
    (t.relayer as unknown as { now: () => number }).now = () => clock;
    await t.relayer.tick();
    // 3.2 s old: 4 whole seconds, plus the second of margin.
    expect(pushed(t.sender.submitted[0]!.req)[2]).toBe(1_000_000n - 1n - 4n);
    // The next cadence comes, but no newer snapshot arrived: nothing is pushed again.
    const now = t.chain.block.timestamp;
    t.chain.markets.set(A(11), { relayed: [39165n * 10n ** 16n, now - 5n, now], band: [39165n * 10n ** 16n, now - 5n, now - 5n] });
    t.chain.markets.set(A(12), { relayed: [23340n * 10n ** 16n, now - 5n, now], band: [23340n * 10n ** 16n, now - 5n, now - 5n] });
    t.chain.block = { number: 101n, timestamp: now + 10n };
    t.setWall(Number(now + 10n) * 1000);
    clock += 4000;
    await t.relayer.tick();
    expect(t.sender.submitted).toHaveLength(1);
    // A replacement of the in-flight push may carry the same snapshots (with higher fees)...
    const again = await t.sender.submitted[0]!.rebuild!();
    expect(again).not.toBeNull();
    // ...but a snapshot older than the one sent never goes out, even then.
    t.seal(snap('TSLA', '391.00', OPEN - 2000));
    t.seal(snap('AMZN', '233.00', OPEN - 4000));
    expect(await t.sender.submitted[0]!.rebuild!()).toBeNull();
    // A newer one does, stamped with its own age.
    t.seal(snap('TSLA', '391.70', OPEN + 3500));
    clock = OPEN + 4000;
    t.sender.next = { state: 'idle' };
    (t.relayer as unknown as { nextCheckAt: number }).nextCheckAt = 0;
    await t.relayer.tick();
    expect(t.sender.submitted).toHaveLength(2);
    const [tokens, , observedAt] = pushed(t.sender.submitted[1]!.req);
    expect(tokens.map((x) => x.toLowerCase())).toEqual([A(11)]);
    expect(observedAt).toBe(now + 10n - 1n - 1n);
  });

  it('backs off after a reverted push and raises an alert until a push succeeds (L-4)', async () => {
    const t = setup(31337, { TSLA: A(11) }, [snap('TSLA', '391.65', OPEN)]);
    t.chain.markets.set(A(11), { relayed: [0n, 0n, 0n], band: [0n, 0n, 0n] });
    await t.relayer.tick();
    expect(t.sender.submitted).toHaveLength(1);
    const wall = Number(t.chain.block.timestamp) * 1000;
    t.sender.next = { state: 'mined', label: 'push:TSLA', receipt: { status: 'reverted', blockNumber: 1n, transactionHash: `0x${'22'.repeat(32)}`, gasUsed: 1n, logs: [] } };
    t.seal(snap('TSLA', '391.70', OPEN + 1));
    await t.relayer.tick();
    expect(t.relayer.status().alerts).toEqual([expect.stringMatching(/price push reverted 1 time\(s\) in a row .* next try in 5 s/)]);
    t.setWall(wall + 4000);
    await t.relayer.tick();
    expect(t.sender.submitted).toHaveLength(1); // still backing off
    t.setWall(wall + 5000);
    await t.relayer.tick();
    expect(t.sender.submitted).toHaveLength(2);
    t.sender.next = { state: 'mined', label: 'push:TSLA', receipt: { status: 'success', blockNumber: 2n, transactionHash: `0x${'23'.repeat(32)}`, gasUsed: 1n, logs: [] } };
    await t.relayer.tick();
    expect(t.relayer.status().alerts).toEqual([]);
  });

  it('refuses to run with a key that is not the oracle relayer', async () => {
    const t = setup(31337, { TSLA: A(11) }, [snap('TSLA', '391.65', OPEN)]);
    t.chain.markets.set(A(11), { relayed: [0n, 0n, 0n], band: [0n, 0n, 0n] });
    t.chain.relayer = A(99);
    await t.relayer.tick();
    expect(t.sender.submitted).toHaveLength(0);
    expect(t.relayer.status().error).toMatch(/oracle's relayer/);
  });

  it('on the configured network, never pushes a quote for a token other than the verified one', async () => {
    const t = setup(46630, { TSLA: A(11), AMZN: TOKENS.AMZN!.address }, [snap('TSLA', '391.65', OPEN), snap('AMZN', '233.40', OPEN)]);
    t.chain.markets.set(A(11), { relayed: [0n, 0n, 0n], band: [0n, 0n, 0n] });
    t.chain.markets.set(TOKENS.AMZN!.address.toLowerCase(), { relayed: [0n, 0n, 0n], band: [0n, 0n, 0n] });
    await t.relayer.tick();
    const [tokens] = pushed(t.sender.submitted[0]!.req);
    expect(tokens.map((x) => x.toLowerCase())).toEqual([TOKENS.AMZN!.address.toLowerCase()]);
    expect(t.relayer.status().markets.TSLA).toBe('token-mismatch');
  });

  it('pushes nothing while the sequencer is down or the session is closed', async () => {
    const t = setup(31337, { TSLA: A(11) }, [snap('TSLA', '391.65', OPEN)]);
    t.chain.markets.set(A(11), { relayed: [0n, 0n, 0n], band: [0n, 0n, 0n] });
    t.chain.sequencer = [false, false];
    await t.relayer.tick();
    expect(t.sender.submitted).toHaveLength(0);
    expect(t.relayer.status()).toMatchObject({ sequencerUp: false, markets: { TSLA: 'sequencer-down' } });
    const closed = setup(31337, { TSLA: A(11) }, [snap('TSLA', '391.65', SUNDAY)], SUNDAY);
    closed.chain.markets.set(A(11), { relayed: [0n, 0n, 0n], band: [0n, 0n, 0n] });
    await closed.relayer.tick();
    expect(closed.sender.submitted).toHaveLength(0);
    expect(closed.relayer.status().markets.TSLA).toBe('closed');
  });

  it('waits for the cadence, defers a move the rate limit would clamp, then pushes when it fits', async () => {
    const P = 400n * E18;
    const t = setup(31337, { TSLA: A(11) }, [snap('TSLA', '400.8', OPEN)]); // +0.2%: needs 12 s of allowance
    const now = t.chain.block.timestamp;
    t.chain.markets.set(A(11), { relayed: [P, now - 5n, now - 5n], band: [P, now - 5n, now - 5n] });
    t.setWall(Number(now) * 1000);
    await t.relayer.tick(); // 5 s after the last push: cadence
    expect(t.sender.submitted).toHaveLength(0);
    expect(t.relayer.status().markets.TSLA).toBe('waiting');
    t.chain.block = { number: 101n, timestamp: now + 4n }; // 9 s: due, but 0.2% does not fit 9 s
    t.setWall(Number(now + 4n) * 1000 + 2000);
    await t.relayer.tick();
    expect(t.sender.submitted).toHaveLength(0);
    expect(t.relayer.status().markets.TSLA).toBe('deferred');
    t.chain.block = { number: 102n, timestamp: now + 7n }; // 12 s: fits exactly (and the 12 s gap limit allows the wait)
    t.setWall(Number(now + 7n) * 1000 + 2000);
    await t.relayer.tick();
    expect(t.sender.submitted).toHaveLength(1);
    expect(pushed(t.sender.submitted[0]!.req)[1]).toEqual([4008n * 10n ** 17n]);
  });

  it('runs the chain clock on from the newest block when the chain is ahead of the wall clock and idle', async () => {
    const t = setup(31337, { TSLA: A(11) }, [snap('TSLA', '400', OPEN)]);
    const ahead = 5_000_000n; // a local chain warped ahead
    t.chain.block = { number: 200n, timestamp: ahead };
    t.setWall(1_000_000_000);
    expect(t.relayer.chainNow(t.chain.block)).toBe(ahead);
    t.setWall(1_000_000_000 + 12_000); // 12 s later, no new block
    expect(t.relayer.chainNow(t.chain.block)).toBe(ahead + 12n);
    // A lower block number (a reorg) resets the reference.
    expect(t.relayer.chainNow({ number: 150n, timestamp: ahead - 100n })).toBe(ahead - 100n);
  });

  it('marks a push the limit clamped as lagging, and a rebuild with nothing qualifying cancels', async () => {
    const t = setup(31337, { TSLA: A(11) }, [snap('TSLA', '391.65', OPEN)]);
    t.chain.markets.set(A(11), { relayed: [0n, 0n, 0n], band: [0n, 0n, 0n] });
    await t.relayer.tick();
    const topics = encodeEventTopics({ abi: abis.oracle, eventName: 'PriceRelayed', args: { token: A(11) } }) as Hex[];
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [400n * E18, 391n * E18, 0n, 1n]);
    t.sender.next = { state: 'mined', label: 'push:TSLA', receipt: { status: 'success', blockNumber: 1n, transactionHash: `0x${'22'.repeat(32)}`, gasUsed: 1n, logs: [{ address: A(2), topics, data, logIndex: 0 }] } };
    t.chain.markets.set(A(11), { relayed: [400n * E18, t.chain.block.timestamp, t.chain.block.timestamp], band: [391n * E18, t.chain.block.timestamp, t.chain.block.timestamp] });
    await t.relayer.tick();
    expect(t.relayer.status().markets.TSLA).toBe('lagging');
    expect(t.relayer.status().lastPushBlockTime).toBe(1);
    // The quote went stale: the pending push's replacement is a cancellation.
    t.seal(snap('TSLA', '391.65', OPEN - 60_000));
    expect(await t.sender.submitted[0]!.rebuild!()).toBeNull();
  });
});
