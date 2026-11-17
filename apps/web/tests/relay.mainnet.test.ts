/**
 * Deposits from Robinhood Chain into Hyperliquid through Relay (lib/hyperliquid/relay.ts). Two real quotes recorded on
 * 2026-11-17 (0.02 ETH and 25 USDG to Hyperliquid perps USDC, for a throwaway address) must be accepted, and any change
 * that would send funds elsewhere or differently must be refused before the wallet is asked. The flow runs against a
 * mocked wallet, chain and Relay: exact approval (skipped when given), one deposit (never twice), the re-quote guard,
 * Relay's status, and the refund case.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ViemModule from 'viem';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

const h = vi.hoisted(() => ({
  chain: 4663,
  allowance: 0n,
  sent: [] as Array<{ to: string; data: string; value: bigint }>,
  approvals: [] as Array<{ address: string; args: unknown[] }>,
  receipt: { status: 'success' } as { status: string },
  hl: [0] as number[],
  user: '0x92ef4c8d8df09a9ae7ed9a12409bc9a84fb70e7b' as `0x${string}`,
  requests: [] as string[],
  l1Receipts: 0,
}));

vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));
vi.mock('wagmi/actions', () => ({
  getConnection: () => ({
    status: 'connected',
    address: h.user,
    connector: {
      getProvider: async () => ({
        request: async ({ method, params }: { method: string; params?: Array<{ chainId?: string }> }) => {
          h.requests.push(method);
          if (method === 'eth_chainId') return `0x${h.chain.toString(16)}`;
          if (method === 'wallet_switchEthereumChain') h.chain = Number.parseInt(params![0]!.chainId!, 16);
          return null;
        },
      }),
    },
  }),
}));
vi.mock('@/lib/chain', () => ({
  robinhoodChain: { id: 4663 },
  publicClient: {
    readContract: async () => h.allowance,
    waitForTransactionReceipt: async () => h.receipt,
  },
}));
vi.mock('viem', async (orig) => {
  const real = await orig<typeof ViemModule>();
  return {
    ...real,
    createWalletClient: () => ({
      sendTransaction: async (t: { to: string; data: string; value: bigint }) => {
        h.sent.push(t);
        return '0x' + 'cd'.repeat(32);
      },
      writeContract: async (a: { address: string; args: unknown[] }) => {
        h.approvals.push(a);
        return '0x' + 'ef'.repeat(32);
      },
    }),
  };
});
vi.mock('@/lib/hyperliquid/deposit', () => ({ hlUsdcTotal: async () => (h.hl.length > 1 ? h.hl.shift()! : h.hl[0]!) }));
vi.mock('@/lib/ethereumEth', () => ({
  l1: {
    waitForTransactionReceipt: async () => {
      h.l1Receipts++;
      return h.receipt;
    },
  },
}));

import { RELAY_DEPOSITORY } from '@velum/config/src/hyperliquid';
import { encodeFunctionData, erc20Abi } from 'viem';
import { RelayQuoteError, hlUsdcText, relayDepositFlow, relayQuote, sourceText, sourceUnits, validateQuote, type RelayPlan } from '@/lib/hyperliquid/relay';
import type { HlCtx } from '@/lib/hyperliquid/flows';
import ethQuote from './fixtures/relay-quote-eth-2026-11-17.json';
import usdgQuote from './fixtures/relay-quote-usdg-2026-11-17.json';
import l1Quote from './fixtures/relay-quote-ethereum-eth-2026-11-17.json';

const USER = h.user;
const ETH_AMT = 20000000000000000n; // 0.02 ETH
const USDG_AMT = 25000000n; // 25 USDG
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
type Q = typeof ethQuote & { steps: Array<{ id: string; items: Array<{ data: Record<string, unknown>; check?: { endpoint: string } }> }> };
const ctx = (): HlCtx => ({ user: USER, agent: null, out: {} });
const jsonRes = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  h.chain = 4663;
  h.requests = [];
  h.l1Receipts = 0;
  h.allowance = 0n;
  h.sent = [];
  h.approvals = [];
  h.receipt = { status: 'success' };
  h.hl = [0];
});

describe('validating Relay quotes', () => {
  it('accepts the real ETH quote: one deposit of exactly 0.02 ETH to the pinned depository', () => {
    const p = validateQuote(ethQuote, { user: USER, source: 'ETH', amount: ETH_AMT });
    expect(p.deposit.to).toBe(RELAY_DEPOSITORY);
    expect(p.deposit.value).toBe(ETH_AMT);
    expect(hlUsdcText(p.out)).toBe('34.83');
    expect(hlUsdcText(p.minOut)).toBe('34.14');
    expect(p.check).toMatch(/^\/intents\/status\?requestId=0x[0-9a-f]{64}$/);
    expect(p.feeUsd).toBeCloseTo(1.28, 1);
  });

  it('accepts the real USDG quote: an exact approval to the depository, then the deposit with no ETH', () => {
    const p = validateQuote(usdgQuote, { user: USER, source: 'USDG', amount: USDG_AMT });
    expect(p.deposit.value).toBe(0n);
    expect(hlUsdcText(p.out)).toBe('23.77');
  });

  const refuse = (q: unknown, source: 'ETH' | 'USDG' = 'ETH', amount = ETH_AMT) => () => validateQuote(q, { user: USER, source, amount });
  it('refuses anything that would send funds elsewhere or differently', () => {
    const other = '0x1111111111111111111111111111111111111111';
    const cases: Array<[string, (q: Q) => void]> = [
      ['another recipient', (q) => (q.details.recipient = other)],
      ['another sender', (q) => (q.details.sender = other)],
      ['another contract', (q) => (q.steps[0]!.items[0]!.data.to = other)],
      ['another value', (q) => (q.steps[0]!.items[0]!.data.value = '20000000000000001')],
      ['another chain', (q) => (q.steps[0]!.items[0]!.data.chainId = 1)],
      ['another output', (q) => (q.details.currencyOut.currency.chainId = 42161)],
      ['another input amount', (q) => (q.details.currencyIn.amount = '1')],
      ['an unknown step', (q) => q.steps.push({ id: 'signature', items: [{ data: {} }] })],
      ['no status link', (q) => ((q.steps[0]!.items[0]! as { check?: { endpoint: string; method?: string } }).check = { endpoint: 'https://evil.example/status', method: 'GET' })],
      ['a minimum above the estimate', (q) => (q.details.currencyOut.minimumAmount = '9999999999999')],
    ];
    for (const [why, mut] of cases) {
      const q = clone(ethQuote) as Q;
      mut(q);
      expect(refuse(q), why).toThrow(RelayQuoteError);
    }
    // The wrong user, or the ETH quote presented as USDG.
    expect(() => validateQuote(ethQuote, { user: other, source: 'ETH', amount: ETH_AMT })).toThrow(/another sender|another recipient/);
    expect(refuse(ethQuote, 'USDG', USDG_AMT)).toThrow(RelayQuoteError);
  });

  it('refuses an unlimited approval, or one to another spender', () => {
    for (const [spender, amount] of [
      [RELAY_DEPOSITORY, 2n ** 256n - 1n],
      ['0x1111111111111111111111111111111111111111', USDG_AMT],
    ] as const) {
      const q = clone(usdgQuote) as unknown as Q;
      q.steps[0]!.items[0]!.data.data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender as `0x${string}`, amount] });
      expect(refuse(q, 'USDG', USDG_AMT)).toThrow(/not an exact approval/);
    }
  });
});

describe('quoting', () => {
  it('posts the route and validates the answer', async () => {
    let body: Record<string, unknown> = {};
    const f = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonRes(ethQuote);
    }) as unknown as typeof fetch;
    const p = await relayQuote({ user: USER, source: 'ETH', amount: ETH_AMT }, f);
    expect(body).toMatchObject({ user: USER, recipient: USER, originChainId: 4663, destinationChainId: 1337, destinationCurrency: '0x00000000000000000000000000000000', tradeType: 'EXACT_INPUT', amount: ETH_AMT.toString() });
    expect(p.deposit.to).toBe(RELAY_DEPOSITORY);
  });

  it('reads Relay errors plainly', async () => {
    const f = (async () => jsonRes({ message: 'Amount too low' }, 400)) as unknown as typeof fetch;
    await expect(relayQuote({ user: USER, source: 'ETH', amount: 1n }, f)).rejects.toThrow(/too small/);
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(relayQuote({ user: USER, source: 'ETH', amount: 1n }, down)).rejects.toThrow(/cannot be reached/);
  });

  it('amounts: typed text to base units and back', () => {
    expect(sourceUnits('ETH', '0.02')).toBe(ETH_AMT);
    expect(sourceUnits('USDG', '25')).toBe(USDG_AMT);
    expect(sourceUnits('USDG', '1.1234567')).toBeNull();
    expect(sourceText('ETH', ETH_AMT)).toBe('0.02');
    expect(sourceText('USDG', USDG_AMT)).toBe('25.00');
  });
});

describe('the deposit flow', () => {
  const statusFetch = (statuses: string[], quote: unknown = ethQuote) =>
    (async (url: string) => (String(url).endsWith('/quote') ? jsonRes(quote) : jsonRes({ status: statuses.length > 1 ? statuses.shift() : statuses[0] }))) as unknown as typeof fetch;
  const plan = (q: unknown = ethQuote, source: 'ETH' | 'USDG' = 'ETH', amount = ETH_AMT): RelayPlan => validateQuote(q, { user: USER, source, amount });

  it('ETH: sends one deposit to the depository, waits for Relay, and never sends twice', async () => {
    const f = relayDepositFlow({ user: USER, source: 'ETH', amount: ETH_AMT, plan: plan(), fetchImpl: statusFetch(['pending', 'success']), pollMs: 1, waitMs: 2000 });
    expect(f.steps.map((s) => s.t)).toEqual(['Send 0.02 ETH to your perps account through Relay', 'Wait for Relay to deliver it']);
    const c = ctx();
    expect(await f.steps[0]!.run(c)).toMatch(/^Confirmed on Robinhood Chain/);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.to).toBe(RELAY_DEPOSITORY);
    expect(h.sent[0]!.value).toBe(ETH_AMT);
    expect(await f.steps[0]!.run(c)).toMatch(/^Confirmed/);
    expect(h.sent).toHaveLength(1);
    expect(await f.steps[1]!.run(c)).toBe('34.83 USDC delivered');
    const review = Object.fromEntries(f.review.map(([k, v]) => [String(k), String(v)]));
    expect(review['You send']).toMatch(/0\.02 ETH from your wallet on Robinhood Chain/);
    expect(review.Minimum).toMatch(/34\.14 USDC/);
    expect(f.ack).toMatch(/real ETH/);
  });

  it('USDG: approves exactly the amount to the depository (skipped when already allowed)', async () => {
    const f = relayDepositFlow({ user: USER, source: 'USDG', amount: USDG_AMT, plan: plan(usdgQuote, 'USDG', USDG_AMT), fetchImpl: statusFetch(['success'], usdgQuote), pollMs: 1, waitMs: 2000 });
    expect(f.steps.map((s) => s.t)[0]).toBe('Allow Relay to take exactly 25.00 USDG');
    expect(await f.steps[0]!.run(ctx())).toMatch(/^Approved/);
    expect(h.approvals[0]!.args).toEqual([RELAY_DEPOSITORY, USDG_AMT]);
    h.allowance = USDG_AMT;
    expect(await f.steps[0]!.run(ctx())).toBeNull();
    expect(h.approvals).toHaveLength(1);
    expect(await f.steps[1]!.run(ctx())).toMatch(/^Confirmed/);
    expect(h.sent[0]!.value).toBe(0n);
  });

  it('refuses to send when the fresh quote guarantees less than the reviewed minimum', async () => {
    const worse = clone(ethQuote) as Q;
    worse.details.currencyOut.minimumAmount = '3000000000';
    const f = relayDepositFlow({ user: USER, source: 'ETH', amount: ETH_AMT, plan: plan(), fetchImpl: statusFetch(['success'], worse), pollMs: 1, waitMs: 500 });
    await expect(f.steps[0]!.run(ctx())).rejects.toThrow(/less than the 34\.14 you reviewed\. Nothing was sent/);
    expect(h.sent).toHaveLength(0);
  });

  it('a reverted deposit allows a fresh send; a refund is said plainly', async () => {
    h.receipt = { status: 'reverted' };
    const f = relayDepositFlow({ user: USER, source: 'ETH', amount: ETH_AMT, plan: plan(), fetchImpl: statusFetch(['refund']), pollMs: 1, waitMs: 500 });
    const c = ctx();
    await expect(f.steps[0]!.run(c)).rejects.toThrow(/reverted/);
    expect(c.out.relayHash).toBeUndefined();
    await expect(f.steps[1]!.run(c)).rejects.toThrow(/refunded it to your wallet on Robinhood Chain/);
  });
});

describe('deposits from Ethereum', () => {
  const L1_USER = (l1Quote as { details: { sender: string } }).details.sender as `0x${string}`;
  it('accepts the real Ethereum quote: one deposit of exactly 0.02 ETH to the same depository, on chain 1', () => {
    const p = validateQuote(l1Quote, { user: L1_USER, source: 'ETH', amount: ETH_AMT, origin: 'ethereum' });
    expect(p.deposit.to).toBe(RELAY_DEPOSITORY);
    expect(p.deposit.value).toBe(ETH_AMT);
    expect(hlUsdcText(p.out)).toBe('34.50');
  });

  it('refuses a quote for the other chain, and USDG from Ethereum', () => {
    // The Robinhood Chain quote presented as an Ethereum one, and the other way round.
    expect(() => validateQuote(ethQuote, { user: USER, source: 'ETH', amount: ETH_AMT, origin: 'ethereum' })).toThrow(RelayQuoteError);
    expect(() => validateQuote(l1Quote, { user: L1_USER, source: 'ETH', amount: ETH_AMT, origin: 'robinhood' })).toThrow(RelayQuoteError);
    expect(() => validateQuote(usdgQuote, { user: USER, source: 'USDG', amount: USDG_AMT, origin: 'ethereum' })).toThrow(/USDG from Ethereum/);
  });

  it('switches the wallet to Ethereum for the deposit, reads its receipt there, and switches back', async () => {
    h.user = L1_USER;
    try {
      const plan = validateQuote(l1Quote, { user: L1_USER, source: 'ETH', amount: ETH_AMT, origin: 'ethereum' });
      const statusFetch = (async (url: string) => (String(url).endsWith('/quote') ? jsonRes(l1Quote) : jsonRes({ status: 'success' }))) as unknown as typeof fetch;
      const f = relayDepositFlow({ user: L1_USER, origin: 'ethereum', source: 'ETH', amount: ETH_AMT, plan, fetchImpl: statusFetch, pollMs: 1, waitMs: 500 });
      expect(f.steps.map((s) => s.t)).toEqual(['Send 0.02 ETH to your perps account through Relay', 'Wait for Relay to deliver it', 'Switch your wallet back to Robinhood Chain']);
      const c: HlCtx = { user: L1_USER, agent: null, out: {} };
      expect(await f.steps[0]!.run(c)).toMatch(/^Confirmed on Ethereum/);
      expect(h.requests).toContain('wallet_switchEthereumChain');
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]!.value).toBe(ETH_AMT);
      expect(h.l1Receipts).toBe(1);
      expect(await f.steps[1]!.run(c)).toMatch(/USDC delivered/);
      expect(await f.steps[2]!.run(c)).toBe('Switched back');
      expect(h.chain).toBe(4663);
      const review = Object.fromEntries(f.review.map(([k, v]) => [String(k), String(v)]));
      expect(review['You send']).toMatch(/from your wallet on Ethereum/);
      expect(review.Network).toMatch(/Ethereum mainnet/);
    } finally {
      h.user = USER;
    }
  });
});
