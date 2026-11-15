/**
 * The keeper's cover claims, found on the chain (on-chain audit M-2): CoverClaimFiled logs of the deployment's perps
 * engine, confirmed unpaid with the coverClaims view. Reorg overlap, provider caps, the saved scan position.
 */
import { parseDeployment } from '@velum/config/src/onchain';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../lib/log';
import { abis } from './chain';
import { CoverClaims, REORG_OVERLAP_BLOCKS, type CoverClient } from './cover-claims';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const PERPS = A(5);
const dep = (() => {
  const r = parseDeployment({ chainId: 46630, startBlock: 100, contracts: { vault: A(1), oracle: A(2), spotPools: A(3), makerBook: A(4), perpsMarkets: PERPS }, tokens: { USDG: A(10), TSLA: A(11) } }, 46630);
  if (!r.ok) throw new Error(r.error);
  return r.deployment;
})();
const lines: string[] = [];
const log: Logger = { debug: () => undefined, info: () => undefined, warn: (m) => void lines.push(m), error: (m) => void lines.push(m) };

function chain() {
  const st = {
    head: 1000n,
    claims: [] as Array<{ block: bigint; epoch: bigint; account: Address; amount: bigint; address?: Address }>,
    /** Largest range the provider answers (blocks), and blocks it refuses even alone. */
    cap: 1_000_000n,
    refuse: new Set<bigint>(),
    ranges: [] as Array<[bigint, bigint]>,
    receipts: true,
  };
  const log = (c: (typeof st.claims)[number]) => ({
    address: c.address ?? PERPS,
    topics: encodeEventTopics({ abi: abis.perpsMarkets, eventName: 'CoverClaimFiled', args: { epoch: c.epoch, account: c.account } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [c.amount]),
  });
  const client: CoverClient = {
    getBlockNumber: (async () => st.head) as unknown as CoverClient['getBlockNumber'],
    getLogs: (async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      st.ranges.push([fromBlock, toBlock]);
      if (toBlock - fromBlock + 1n > st.cap) throw new Error('query exceeds max block range 100');
      for (const b of st.refuse) if (b >= fromBlock && b <= toBlock) throw new Error('Log response size exceeded');
      return st.claims.filter((c) => c.block >= fromBlock && c.block <= toBlock).map(log);
    }) as unknown as CoverClient['getLogs'],
    readContract: (async ({ args }: { args: readonly unknown[] }) => st.claims.find((c) => c.epoch === args[0] && c.account.toLowerCase() === String(args[1]).toLowerCase() && !c.address)?.amount ?? 0n) as unknown as CoverClient['readContract'],
    request: (async ({ params }: { params: [Hex] }) => {
      if (!st.receipts) throw new Error('method not found');
      const n = BigInt(params[0]);
      return [{ logs: st.claims.filter((c) => c.block === n).map(log) }];
    }) as unknown as CoverClient['request'],
  };
  return { st, client };
}

describe('CoverClaims (from the chain, M-2)', () => {
  it('finds the unpaid claims of ended epochs, oldest first, and drops paid ones; ignores other contracts', async () => {
    const { st, client } = chain();
    st.claims = [
      { block: 500n, epoch: 9n, account: A(40), amount: 5n },
      { block: 400n, epoch: 8n, account: A(41), amount: 2n },
      { block: 450n, epoch: 8n, account: A(42), amount: 0n }, // paid
      { block: 600n, epoch: 10n, account: A(43), amount: 1n }, // current epoch
      { block: 700n, epoch: 7n, account: A(44), amount: 9n, address: A(99) }, // another contract's event
    ];
    const c = new CoverClaims({ client, deployment: dep, confirmations: 3, chunkBlocks: 2000, log });
    await c.scan();
    expect(c.scannedTo).toBe(997n);
    expect(st.ranges[0]).toEqual([100n, 997n]); // from the deployment's start block
    expect(await c.due(10n, 5)).toEqual([
      { epoch: 8n, account: A(41) },
      { epoch: 9n, account: A(40) },
    ]);
    // Paid since: dropped for good.
    st.claims[1]!.amount = 0n;
    expect(await c.due(11n, 5)).toEqual([
      { epoch: 9n, account: A(40) },
      { epoch: 10n, account: A(43) },
    ]);
  });

  it('reads the last blocks again on every scan, so a claim a reorg moved is still found', async () => {
    const { st, client } = chain();
    const c = new CoverClaims({ client, deployment: dep, confirmations: 0, chunkBlocks: 2000, log });
    await c.scan();
    // A reorg re-includes a claim in a block below the scan position.
    st.claims.push({ block: 990n, epoch: 3n, account: A(50), amount: 4n });
    st.head = 1010n;
    st.ranges = [];
    await c.scan();
    expect(st.ranges[0]).toEqual([1000n - REORG_OVERLAP_BLOCKS + 1n, 1010n]);
    expect(await c.due(4n, 5)).toEqual([{ epoch: 3n, account: A(50) }]);
  });

  it('halves a range the provider refuses, reads one refused block with eth_getBlockReceipts, alerts if that fails too', async () => {
    const { st, client } = chain();
    st.cap = 100n;
    st.refuse.add(300n);
    st.claims = [{ block: 300n, epoch: 1n, account: A(60), amount: 3n }];
    const c = new CoverClaims({ client, deployment: dep, confirmations: 0, chunkBlocks: 1000, log, now: () => 0 });
    for (let i = 0; i < 20 && c.scannedTo < 1000n; i++) await c.scan();
    expect(c.scannedTo).toBe(1000n);
    expect(await c.due(2n, 5)).toEqual([{ epoch: 1n, account: A(60) }]);
    expect(c.alerts()).toEqual([]);
    const other = chain();
    other.st.refuse.add(150n);
    other.st.receipts = false;
    const d = new CoverClaims({ client: other.client, deployment: dep, confirmations: 0, chunkBlocks: 1000, log, now: () => 0 });
    for (let i = 0; i < 30 && d.scannedTo < 1000n; i++) await d.scan();
    expect(d.alerts()[0]).toMatch(/could not read the cover claims of block 150/);
  });

  it('keeps its position and open pairs in its state, for this deployment only', async () => {
    const { st, client } = chain();
    st.claims = [{ block: 200n, epoch: 2n, account: A(70), amount: 1n }];
    let saved: unknown = null;
    const state = { read: () => saved, write: (v: unknown) => (saved = JSON.parse(JSON.stringify(v))) };
    await new CoverClaims({ client, deployment: dep, confirmations: 0, chunkBlocks: 2000, log, state }).scan();
    expect(saved).toMatchObject({ v: 1, deployment: PERPS, cursor: '1000', pairs: [['2', A(70)]] });
    st.ranges = [];
    const again = new CoverClaims({ client, deployment: dep, confirmations: 0, chunkBlocks: 2000, log, state });
    expect(again.scannedTo).toBe(1000n);
    await again.scan();
    expect(st.ranges[0]![0]).toBe(1000n - REORG_OVERLAP_BLOCKS + 1n); // not from the start again
    expect(await again.due(3n, 5)).toEqual([{ epoch: 2n, account: A(70) }]);
    // Another deployment's state (or a malformed one) is ignored.
    const otherDep = { ...dep, contracts: { ...dep.contracts, perpsMarkets: A(6) } };
    expect(new CoverClaims({ client, deployment: otherDep, confirmations: 0, chunkBlocks: 2000, log, state }).scannedTo).toBe(99n);
  });
});
