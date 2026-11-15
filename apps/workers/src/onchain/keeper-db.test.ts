/**
 * The keeper's unpaid-cover-claims query against a real Postgres (TEST_DATABASE_URL, a migrated scratch database;
 * skipped without it). On-chain workers audit L-9: the keeper read every CoverClaimFiled and CoverPaid event oldest
 * first, capped at 5,000, so once the history grew past the cap it never saw a new claim.
 */
import { parseDeployment, type Deployment } from '@velum/config/src/onchain';
import { PrismaClient } from '@velum/db';
import type { Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../lib/log';
import { Keeper, type KeeperClient } from './keeper';
import type { TxSender } from './tx-sender';

const DB = process.env.TEST_DATABASE_URL;
const CHAIN = 990_002;
const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const silent: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

describe.skipIf(!DB)('keeper cover claims on Postgres (L-9)', () => {
  let prisma: PrismaClient;
  let d: Deployment;
  const clean = () => prisma.chainEvent.deleteMany({ where: { chainId: { in: [CHAIN, CHAIN + 1] } } });

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB! } } });
    const r = parseDeployment({ chainId: CHAIN, startBlock: 1, contracts: { vault: A(1), oracle: A(2), spotPools: A(3), makerBook: A(4), perpsMarkets: A(5) }, tokens: { USDG: A(10), TSLA: A(11) } }, CHAIN);
    if (!r.ok) throw new Error(r.error);
    d = r.deployment;
    await clean();
  });
  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
  });

  it('selects the unpaid claims of ended epochs in SQL, oldest epoch first, however long the history', async () => {
    let n = 0;
    const ev = (kind: 'CoverClaimFiled' | 'CoverPaid', epoch: number, account: Hex, block: number, o: { chainId?: number; address?: Hex } = {}) => ({
      chainId: o.chainId ?? CHAIN,
      kind,
      address: o.address ?? d.contracts.perpsMarkets,
      txHash: `0x${(++n).toString(16)}`,
      logIndex: 0,
      block: BigInt(block),
      data: { epoch: String(epoch), account, ...(kind === 'CoverClaimFiled' ? { amount: '1' } : { claim: '1', paid: '1' }) },
    });
    // 6,000 events of claims filed and paid long ago: more than the old 5,000 cap.
    const history = [];
    for (let i = 0; i < 3000; i++) history.push(ev('CoverClaimFiled', 1, A(1000 + i), 10 + i), ev('CoverPaid', 1, A(1000 + i), 5000 + i));
    await prisma.chainEvent.createMany({ data: history });
    await prisma.chainEvent.createMany({
      data: [
        ev('CoverClaimFiled', 6, A(41), 9000),
        ev('CoverPaid', 6, A(41), 9001), // paid
        ev('CoverPaid', 4, A(42), 9002),
        ev('CoverClaimFiled', 4, A(42), 9003), // filed again after a payout: open
        ev('CoverClaimFiled', 10, A(43), 9004), // the current epoch: not yet
        ev('CoverClaimFiled', 2, A(44), 9005, { chainId: CHAIN + 1 }), // another chain
        ev('CoverClaimFiled', 2, A(45), 9006, { address: A(99) }), // another deployment
        ev('CoverClaimFiled', 7, A(40), 9007), // new, unpaid: the claim the capped read never saw
        ev('CoverClaimFiled', 7, A(40), 9008), // the same claim twice: once
      ],
    });
    const client = { readContract: async () => 10n } as unknown as KeeperClient;
    const keeper = new Keeper({ client, sender: {} as TxSender, prisma, deployment: d, chainId: CHAIN, fundingEpochSeconds: 3600, ethPriceUsd: 4000n, maxFeeWei: 1n, log: silent });
    const actions = await (keeper as unknown as { coverActions(): Promise<Array<{ epoch: bigint; account: string }>> }).coverActions();
    expect(actions.map((a) => [a.epoch, a.account])).toEqual([
      [4n, A(42)],
      [7n, A(40)],
    ]);
  });
});
