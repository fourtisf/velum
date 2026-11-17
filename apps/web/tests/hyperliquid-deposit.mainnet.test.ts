/**
 * Deposits into Hyperliquid from inside Velum (lib/hyperliquid/deposit.ts), with the wallet, Arbitrum and Hyperliquid
 * mocked: the amount rules (at least 5 USDC, within the balance, gas present), the flow's steps, that the transfer goes to
 * the bridge in native USDC exactly once (a retry only waits for the same transaction), and how the credit is awaited.
 * The real contracts are exercised on an Arbitrum fork by e2e/hyperliquid-deposit.e2e.cjs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ViemModule from 'viem';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

const h = vi.hoisted(() => ({
  chain: 4663,
  requests: [] as Array<{ method: string; params?: unknown }>,
  switchError: null as null | { code: number; message: string },
  usdc: 100_000000n,
  eth: 10n ** 15n,
  writes: [] as Array<{ address: string; functionName: string; args: unknown[] }>,
  receipt: null as null | Record<string, unknown>,
  totals: [] as number[],
  address: '0x1111111111111111111111111111111111111111' as `0x${string}`,
}));

vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));
vi.mock('wagmi/actions', () => ({
  getConnection: () => ({
    status: 'connected',
    address: h.address,
    connector: {
      getProvider: async () => ({
        request: async ({ method, params }: { method: string; params?: Array<{ chainId?: string }> }) => {
          h.requests.push({ method, params });
          if (method === 'eth_chainId') return `0x${h.chain.toString(16)}`;
          if (method === 'wallet_switchEthereumChain') {
            if (h.switchError) {
              const e = h.switchError;
              h.switchError = null;
              throw Object.assign(new Error(e.message), { code: e.code });
            }
            h.chain = Number.parseInt(params![0]!.chainId!, 16);
            return null;
          }
          if (method === 'wallet_addEthereumChain') {
            h.chain = Number.parseInt(params![0]!.chainId!, 16);
            return null;
          }
          throw new Error(`unexpected ${method}`);
        },
      }),
    },
  }),
  getWalletClient: async () => ({}),
}));
vi.mock('viem', async (orig) => {
  const real = await orig<typeof ViemModule>();
  return {
    ...real,
    createPublicClient: () => ({
      readContract: async () => h.usdc,
      getBalance: async () => h.eth,
      waitForTransactionReceipt: async () => h.receipt,
    }),
    createWalletClient: () => ({
      writeContract: async (a: { address: string; functionName: string; args: unknown[] }) => {
        h.writes.push(a);
        return '0x' + 'ab'.repeat(32);
      },
    }),
  };
});
vi.mock('@/lib/hyperliquid/client', () => ({
  info: {
    clearinghouseState: async ({ dex }: { dex?: string }) => ({ withdrawable: dex ? '0' : String(h.totals.length > 1 ? h.totals.shift()! : (h.totals[0] ?? 0)) }),
    spotClearinghouseState: async () => ({ balances: [] }),
  },
}));

import { ARB_USDC, HL_BRIDGE } from '@velum/config/src/hyperliquid';
import { encodeAbiParameters, pad, type Hex } from 'viem';
import { depositFlow, planDeposit, usdcText, usdcUnits } from '@/lib/hyperliquid/deposit';
import { hlErrorText, type HlCtx } from '@/lib/hyperliquid/flows';

const USER = h.address;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const receipt = (from: string, to: string, value: bigint, token: string = ARB_USDC) => ({
  status: 'success',
  logs: [{ address: token, topics: [TRANSFER, pad(from as Hex), pad(to as Hex)], data: encodeAbiParameters([{ type: 'uint256' }], [value]), blockNumber: 1n, transactionHash: '0x' + 'ab'.repeat(32), logIndex: 0, blockHash: '0x' + '00'.repeat(32), transactionIndex: 0, removed: false }],
});
const ctx = (): HlCtx => ({ user: USER, agent: null, out: {} });

beforeEach(() => {
  h.chain = 4663;
  h.requests = [];
  h.switchError = null;
  h.usdc = 100_000000n;
  h.eth = 10n ** 15n;
  h.writes = [];
  h.receipt = receipt(USER, HL_BRIDGE, 25_000000n);
  h.totals = [0];
});

describe('amounts', () => {
  it('reads plain USDC amounts with up to 6 decimals', () => {
    expect(usdcUnits('5')).toBe(5_000000n);
    expect(usdcUnits('12.345678')).toBe(12_345678n);
    expect(usdcUnits(' 7.5 ')).toBe(7_500000n);
    for (const bad of ['', 'abc', '1e3', '-5', '5.1234567', '1,000']) expect(usdcUnits(bad), bad).toBeNull();
    expect(usdcText(12_345678n)).toBe('12.34');
    expect(usdcText(5_000000n)).toBe('5.00');
  });

  it('refuses anything under 5 USDC (Hyperliquid loses it), above the balance, or without gas', () => {
    const bal = { usdc: 100_000000n, eth: 1n };
    expect(planDeposit('4.999999', bal)).toEqual({ ok: false, reason: 'min' });
    expect(planDeposit('5', bal)).toEqual({ ok: true, units: 5_000000n });
    expect(planDeposit('100.000001', bal)).toEqual({ ok: false, reason: 'balance' });
    expect(planDeposit('10', { usdc: 100_000000n, eth: 0n })).toEqual({ ok: false, reason: 'gas' });
    expect(planDeposit('10', null)).toEqual({ ok: false, reason: 'loading' });
    expect(planDeposit('0', bal)).toEqual({ ok: false, reason: 'amount' });
    expect(planDeposit('x', bal)).toEqual({ ok: false, reason: 'amount' });
  });
});

describe('deposit flow', () => {
  it('switch to Arbitrum, send, wait for the credit, switch back; reviewed first with a real-money statement', () => {
    const f = depositFlow({ user: USER, units: 25_000000n });
    expect(f.steps.map((s) => s.t)).toEqual(['Switch your wallet to Arbitrum', 'Send 25.00 USDC to your perps account', 'Wait for the deposit to be credited', 'Switch your wallet back to Robinhood Chain']);
    expect(Object.fromEntries(f.review.map(([k, v]) => [String(k), String(v)]))).toMatchObject({ Amount: '25.00 USDC', From: 'Your wallet on Arbitrum', To: 'Your perps account (this same address)' });
    expect(f.ack).toMatch(/real USDC/);
    expect(f.note).toMatch(/under 5 USDC are lost/);
  });

  it('switches the wallet to Arbitrum (adding it when unknown), and skips when already there', async () => {
    const f = depositFlow({ user: USER, units: 25_000000n });
    expect(await f.steps[0]!.run(ctx())).toBe('Switched to Arbitrum');
    expect(h.chain).toBe(42161);
    expect(await f.steps[0]!.run(ctx())).toBeNull();
    h.chain = 4663;
    h.switchError = { code: 4902, message: 'Unrecognized chain ID' };
    expect(await f.steps[0]!.run(ctx())).toBe('Switched to Arbitrum');
    expect(h.requests.some((r) => r.method === 'wallet_addEthereumChain')).toBe(true);
  });

  it('sends exactly the amount of native USDC to the bridge, once, and checks the transfer in the receipt', async () => {
    h.chain = 42161;
    const f = depositFlow({ user: USER, units: 25_000000n });
    const c = ctx();
    expect(await f.steps[1]!.run(c)).toMatch(/^Confirmed on Arbitrum/);
    expect(h.writes).toEqual([{ address: ARB_USDC, abi: expect.anything(), functionName: 'transfer', args: [HL_BRIDGE, 25_000000n] }]);
    // A retry of the same step (for example after a receipt timeout) waits for the same transaction: no second send.
    expect(await f.steps[1]!.run(c)).toMatch(/^Confirmed on Arbitrum/);
    expect(h.writes).toHaveLength(1);
  });

  it('refuses before sending when USDC or gas is short, or the wallet is not on Arbitrum', async () => {
    const f = depositFlow({ user: USER, units: 25_000000n });
    h.chain = 42161;
    h.usdc = 24_999999n;
    await expect(f.steps[1]!.run(ctx())).rejects.toThrow(/less than 25.00\. Nothing was sent/);
    h.usdc = 100_000000n;
    h.eth = 0n;
    await expect(f.steps[1]!.run(ctx())).rejects.toThrow(/ETH on Arbitrum/);
    h.eth = 1n;
    h.chain = 4663;
    await expect(f.steps[1]!.run(ctx())).rejects.toThrow(/not on Arbitrum/);
    expect(h.writes).toHaveLength(0);
  });

  it('a receipt without the expected USDC movement fails loudly; a reverted one allows a fresh send', async () => {
    h.chain = 42161;
    const f = depositFlow({ user: USER, units: 25_000000n });
    h.receipt = receipt(USER, '0x2222222222222222222222222222222222222222', 25_000000n);
    await expect(f.steps[1]!.run(ctx())).rejects.toThrow(/without the expected USDC transfer/);
    const c = ctx();
    h.receipt = { status: 'reverted', logs: [] };
    await expect(f.steps[1]!.run(c)).rejects.toThrow(/reverted/);
    expect(c.out.depositHash).toBeUndefined();
  });

  it('waits until Hyperliquid shows the USDC, and says so plainly when it takes too long', async () => {
    const f = depositFlow({ user: USER, units: 25_000000n, pollMs: 5, waitMs: 400 });
    const c = ctx();
    c.out.base = 10;
    h.totals = [10, 10, 34.9];
    expect(await f.steps[2]!.run(c)).toBe('25.00 USDC credited');
    h.totals = [10];
    await expect(f.steps[2]!.run({ ...c, out: { base: 10 } })).rejects.toThrow(/has not shown up yet/);
  });

  it('switches back to Robinhood Chain and never fails the deposit over it', async () => {
    const f = depositFlow({ user: USER, units: 25_000000n });
    h.chain = 42161;
    expect(await f.steps[3]!.run(ctx())).toBe('Switched back');
    expect(h.chain).toBe(4663);
    h.chain = 42161;
    h.switchError = { code: 4001, message: 'User rejected the request.' };
    expect(await f.steps[3]!.run(ctx())).toMatch(/Switch back from your wallet/);
  });
});

describe('error wording', () => {
  it('gas and balance errors from the wallet read plainly', () => {
    expect(hlErrorText(new Error('insufficient funds for gas * price + value'))).toMatch(/ETH on Arbitrum/);
    expect(hlErrorText(new Error('ERC20: transfer amount exceeds balance'))).toMatch(/Not enough USDC on Arbitrum/);
    expect(hlErrorText(new Error('Your wallet holds 3.00 USDC on Arbitrum, less than 25.00. Nothing was sent.'))).toMatch(/^Your wallet holds/);
  });
});
