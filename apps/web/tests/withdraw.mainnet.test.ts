/**
 * Withdrawals from the perps account (lib/hyperliquid/withdraw.ts). Two real Relay quotes recorded on 2026-11-17
 * (12 USDC out of Hyperliquid to USDG on Robinhood Chain and to ETH on Ethereum, for a throwaway address) must be
 * accepted, and any change that would send the USDC elsewhere, sign something else or pay out elsewhere must be refused
 * before the wallet is asked. The flows run against a mocked wallet, exchange and Relay: the stock perps balance freed
 * first when needed, Relay's authorization signed on the wallet's chain, one transfer with Relay's nonce (never twice),
 * the re-quote guard, Relay's status, and the exchange's own withdrawal to Arbitrum.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

const h = vi.hoisted(() => ({
  user: '0x92ef4c8d8df09a9ae7ed9a12409bc9a84fb70e7b' as `0x${string}`,
  fresh: { mode: 'standard', bal: { xyzAvailable: 0, mainAvailable: 50, positions: [] as unknown[], funded: true } } as { mode: string; bal: { xyzAvailable: number; mainAvailable: number; positions: unknown[]; funded: boolean } },
  moves: [] as string[],
  sends: [] as Array<{ nonce: number | undefined; p: Record<string, unknown> }>,
  withdraws: [] as Array<Record<string, unknown>>,
  signed: [] as Array<Record<string, unknown>>,
  approvals: 0,
}));

vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));
vi.mock('@/lib/hyperliquid/client', () => ({
  BUILDER: null,
  info: { extraAgents: async () => [] },
  approveNewAgent: async (user: string) => {
    h.approvals++;
    return { user, address: '0x' + '77'.repeat(20), pk: '0x' + '11'.repeat(32), validUntil: Date.now() + 1e9 };
  },
  agentClient: () => ({}),
  approveBuilder: async () => undefined,
  builderApproved: async () => true,
  builderRate: () => '0%',
  freshAsset: async () => ({}),
  moveToXyz: async () => ({}),
  freshBalances: async () => h.fresh,
  moveFromXyz: async (_agent: unknown, amount: string) => {
    h.moves.push(amount);
    return {};
  },
  userExchange: async (_user: string, nonce?: number) => ({
    sendAsset: async (p: Record<string, unknown>) => {
      h.sends.push({ nonce, p });
      return { status: 'ok' };
    },
    withdraw3: async (p: Record<string, unknown>) => {
      h.withdraws.push(p);
      return { status: 'ok' };
    },
  }),
  userWallet: async () => ({
    getChainId: async () => 4663,
    signTypedData: async (a: Record<string, unknown>) => {
      h.signed.push(a);
      return '0x' + 'ab'.repeat(65);
    },
  }),
}));

import { RELAY_HL_DEPOSIT_ADDRESS } from '@velum/config/src/hyperliquid';
import type { HlCtx } from '@/lib/hyperliquid/flows';
import {
  WithdrawQuoteError,
  arbWithdrawFlow,
  authorizeWithdraw,
  microExact,
  microText,
  outText,
  parseUsdc,
  relaySourceDex,
  relayWithdrawFlow,
  relayWithdrawQuote,
  toMicro,
  validateWithdrawQuote,
  withdrawRefusal,
  withdrawableMicro,
  type WithdrawPlan,
} from '@/lib/hyperliquid/withdraw';
import usdgQuote from './fixtures/relay-withdraw-usdg-2026-11-17.json';
import l1Quote from './fixtures/relay-withdraw-ethereum-eth-2026-11-17.json';

const USER = h.user;
const AMT = 12_000_000n; // 12 USDC
/** The parts of Relay's quote the tests read or edit. */
type Params = { destination: string; amount: string; token: string; sourceDex: string; destinationDex: string; fromSubAccount: string; hyperliquidChain: string; nonce: number };
type Item = {
  data: {
    sign: { domain: { name: string }; types: { NonceMapping: Array<{ name: string; type: string }> }; value: { wallet: string; depositor: string; nonce: number } };
    post: { endpoint: string; body: { id: string } };
    action: { type: string; parameters: Params };
  };
  check?: { endpoint: string };
};
type Step = { id: string; kind: string; requestId: string; items: Item[] };
type Q = {
  details: { sender: string; recipient: string; currencyIn: { amount: string }; currencyOut: { amount: string; minimumAmount: string; currency: { address: string; chainId: number } } };
  steps: Step[];
  fees: Record<string, unknown>;
};
const clone = (x: unknown): Q => JSON.parse(JSON.stringify(x)) as Q;
const ctx = (): HlCtx => ({ user: USER, agent: null, out: {} });
const jsonRes = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const usdg = (q: unknown = usdgQuote) => validateWithdrawQuote(q, { user: USER, to: 'robinhood', asset: 'USDG', amount: AMT, sourceDex: '' });

/** A mocked Relay: quotes (optionally edited), the authorization, and the request's status. */
function relay(opts: { quote?: (q: Q) => void; status?: string[]; authorize?: number } = {}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const status = [...(opts.status ?? ['pending', 'success'])];
  const f = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.endsWith('/quote')) {
      const q = clone(usdgQuote);
      opts.quote?.(q);
      return jsonRes(q);
    }
    if (url.includes('/authorize?signature=')) return jsonRes(opts.authorize && opts.authorize >= 400 ? { error: 'Invalid signature' } : { message: 'Success' }, opts.authorize ?? 200);
    if (url.includes('/intents/status')) return jsonRes({ status: status.length > 1 ? status.shift() : status[0], txHashes: ['0x' + '5e'.repeat(32)] });
    return jsonRes({}, 404);
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function runAll(flow: ReturnType<typeof relayWithdrawFlow>, c = ctx()) {
  const out: Array<string | null> = [];
  for (const s of flow.steps) out.push(await s.run(c));
  return { out, c };
}

beforeEach(() => {
  h.fresh = { mode: 'standard', bal: { xyzAvailable: 0, mainAvailable: 50, positions: [], funded: true } };
  h.moves = [];
  h.sends = [];
  h.withdraws = [];
  h.signed = [];
  h.approvals = 0;
});

describe('validating Relay withdrawal quotes', () => {
  it('accepts the real USDG quote: a transfer of exactly 12 USDC to Relay, USDG to this address on Robinhood Chain', () => {
    const p = usdg();
    expect(p.send).toEqual({ destination: RELAY_HL_DEPOSIT_ADDRESS, sourceDex: '', token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054', amount: '12.000000' });
    expect(p.nonce).toBe((usdgQuote as unknown as Q).steps[0]!.items[0]!.data.sign.value.nonce);
    expect(p.out).toBe(BigInt((usdgQuote as unknown as Q).details.currencyOut.amount));
    expect(p.minOut <= p.out && p.minOut > 0n).toBe(true);
    expect(p.check).toMatch(/^\/intents\/status(\/v\d+)?\?requestId=0x[0-9a-f]{64}$/);
    expect(outText('USDG', p.out)).toMatch(/^11\.\d\d$/);
  });

  it('accepts the real Ethereum quote: ETH on chain 1, same transfer', () => {
    const p = validateWithdrawQuote(l1Quote, { user: USER, to: 'ethereum', asset: 'ETH', amount: AMT, sourceDex: '' });
    expect(p.send.destination).toBe(RELAY_HL_DEPOSIT_ADDRESS);
    expect(outText('ETH', p.out)).toMatch(/^0\.00\d+$/);
  });

  it('expects the balance the account keeps its USDC in: spot for unified accounts, the perps balance otherwise', () => {
    expect(relaySourceDex('unified')).toBe('spot');
    expect(relaySourceDex('portfolio')).toBe('spot');
    expect(relaySourceDex('standard')).toBe('');
    const spot = clone(usdgQuote);
    spot.steps[1]!.items[0]!.data.action.parameters.sourceDex = 'spot';
    expect(validateWithdrawQuote(spot, { user: USER, to: 'robinhood', asset: 'USDG', amount: AMT, sourceDex: 'spot' }).send.sourceDex).toBe('spot');
    expect(() => usdg(spot)).toThrow(/another balance/);
  });

  it('refuses anything that would send the USDC elsewhere, sign something else or pay out elsewhere', () => {
    const cases: Array<[string, (q: Q) => void, RegExp]> = [
      ['another destination', (q) => (q.steps[1]!.items[0]!.data.action.parameters.destination = '0x' + '66'.repeat(20)), /another destination/],
      ['a larger transfer', (q) => (q.steps[1]!.items[0]!.data.action.parameters.amount = '120.000000'), /another transfer amount/],
      ['another token', (q) => (q.steps[1]!.items[0]!.data.action.parameters.token = 'HYPE:0x0d01dc56dcaaca66ad901c959b4011ec'), /another balance or token/],
      ['into another dex', (q) => (q.steps[1]!.items[0]!.data.action.parameters.destinationDex = 'xyz'), /another balance or token/],
      ['from a sub-account', (q) => (q.steps[1]!.items[0]!.data.action.parameters.fromSubAccount = '0x' + '12'.repeat(20)), /another balance or token/],
      ['testnet', (q) => (q.steps[1]!.items[0]!.data.action.parameters.hyperliquidChain = 'Testnet'), /another network/],
      ['not a transfer', (q) => (q.steps[1]!.items[0]!.data.action.type = 'withdraw3'), /not a transfer/],
      ['another nonce in the transfer', (q) => (q.steps[1]!.items[0]!.data.action.parameters.nonce += 1), /another nonce/],
      ['another wallet in the authorization', (q) => (q.steps[0]!.items[0]!.data.sign.value.wallet = '0x' + '99'.repeat(20)), /authorization values/],
      ['another depositor', (q) => (q.steps[0]!.items[0]!.data.sign.value.depositor = '0x' + '99'.repeat(20)), /authorization values/],
      ['another domain', (q) => (q.steps[0]!.items[0]!.data.sign.domain.name = 'Permit2'), /authorization domain/],
      ['other message types', (q) => q.steps[0]!.items[0]!.data.sign.types.NonceMapping.push({ name: 'amount', type: 'uint256' }), /authorization message/],
      ['another endpoint', (q) => (q.steps[0]!.items[0]!.data.post.endpoint = '/execute'), /authorization request/],
      ['another id in the request', (q) => (q.steps[0]!.items[0]!.data.post.body.id = '0x' + '00'.repeat(32)), /authorization request/],
      ['another recipient', (q) => (q.details.recipient = '0x' + '99'.repeat(20)), /another recipient/],
      ['another sender', (q) => (q.details.sender = '0x' + '99'.repeat(20)), /another sender/],
      ['another output token', (q) => (q.details.currencyOut.currency.address = '0x0000000000000000000000000000000000000000'), /another output/],
      ['another output chain', (q) => (q.details.currencyOut.currency.chainId = 1), /another output/],
      ['another input amount', (q) => (q.details.currencyIn.amount = '1300000000'), /another amount/],
      ['a minimum above the estimate', (q) => (q.details.currencyOut.minimumAmount = String(BigInt(q.details.currencyOut.amount) + 1n)), /output amounts/],
      ['an extra step', (q) => q.steps.push(clone(usdgQuote).steps[1]!), /not two steps/],
      ['a status link for another request', (q) => (q.steps[1]!.items[0]!.check!.endpoint = `/intents/status/v3?requestId=0x${'00'.repeat(32)}`), /request id/],
    ];
    for (const [label, edit, why] of cases) {
      const q = clone(usdgQuote);
      edit(q);
      expect(() => usdg(q), label).toThrow(WithdrawQuoteError);
      expect(() => usdg(q), label).toThrow(why);
    }
    // USDG is only paid out on Robinhood Chain.
    expect(() => validateWithdrawQuote(l1Quote, { user: USER, to: 'ethereum', asset: 'USDG', amount: AMT, sourceDex: '' })).toThrow(/USDG to Ethereum/);
  });
});

describe('quoting and authorizing', () => {
  it('asks Relay for exactly the amount (8 decimals) out of Hyperliquid, and reads errors plainly', async () => {
    const { f, calls } = relay();
    await relayWithdrawQuote({ user: USER, to: 'robinhood', asset: 'USDG', amount: AMT, sourceDex: '' }, f);
    expect(calls[0]!.url).toBe('https://api.relay.link/quote');
    expect(calls[0]!.body).toMatchObject({ user: USER, recipient: USER, originChainId: 1337, destinationChainId: 4663, originCurrency: '0x00000000000000000000000000000000', amount: '1200000000', tradeType: 'EXACT_INPUT' });
    const tooSmall = (async () => jsonRes({ message: 'Amount too low' }, 400)) as unknown as typeof fetch;
    await expect(relayWithdrawQuote({ user: USER, to: 'robinhood', asset: 'USDG', amount: 1n, sourceDex: '' }, tooSmall)).rejects.toThrow(/too small/);
  });

  it("signs Relay's message on the wallet's own chain, built from the checked values, and posts it", async () => {
    const plan = usdg();
    const { f, calls } = relay();
    await authorizeWithdraw(USER, plan, f);
    const s = h.signed[0] as { domain: Record<string, unknown>; message: Record<string, unknown>; primaryType: string };
    expect(s.domain).toEqual({ name: 'RelayNonceMapping', version: '2', chainId: 4663, verifyingContract: '0x0000000000000000000000000000000000000000' });
    expect(s.primaryType).toBe('NonceMapping');
    expect(s.message).toEqual({ chainId: 'hyperliquid', wallet: USER, depositor: USER, id: plan.id, nonce: BigInt(plan.nonce) });
    expect(calls[0]!.url).toBe(`https://api.relay.link/authorize?signature=0x${'ab'.repeat(65)}`);
    expect(calls[0]!.body).toEqual({ type: 'nonce-mapping', walletChainId: 1337, wallet: USER, nonce: plan.nonce, id: plan.id, depositor: USER, signatureChainId: 4663 });
    await expect(authorizeWithdraw(USER, plan, relay({ authorize: 400 }).f)).rejects.toThrow(/Relay refused the authorization.*Nothing was sent/);
  });
});

describe('the Relay withdrawal flow', () => {
  const flow = (f: typeof fetch, plan: WithdrawPlan = usdg()) => relayWithdrawFlow({ user: USER, to: 'robinhood', asset: 'USDG', amount: AMT, plan, fetchImpl: f, pollMs: 1, waitMs: 2000 });

  it('authorizes, sends exactly the amount to Relay with its nonce, waits for delivery (never sends twice)', async () => {
    const { f, calls } = relay();
    const fl = flow(f);
    const { out, c } = await runAll(fl);
    expect(out[0]).toBeNull(); // the main balance already holds it
    expect(h.moves).toEqual([]);
    expect(h.signed).toHaveLength(1);
    expect(h.sends).toHaveLength(1);
    const plan = c.out.plan as WithdrawPlan;
    expect(h.sends[0]!.nonce).toBe(plan.nonce);
    expect(h.sends[0]!.p).toEqual({ destination: RELAY_HL_DEPOSIT_ADDRESS, sourceDex: '', destinationDex: '', token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054', amount: '12.000000', fromSubAccount: '' });
    expect(out[3]).toMatch(/USDG delivered on Robinhood Chain/);
    expect(calls.filter((x) => x.url.includes('/intents/status')).length).toBe(2);
    // A retry of the transfer step after it went out sends nothing.
    expect(await fl.steps[2]!.run(c)).toBe('Already sent');
    expect(await fl.steps[1]!.run(c)).toBeNull();
    expect(h.sends).toHaveLength(1);
    const done = fl.done(c);
    expect(done.toast).toBe('Withdrawal delivered');
    expect(fl.review.map((r) => String(r[0]))).toEqual(['You withdraw', 'You receive (est.)', 'Minimum', 'To', 'Venue', 'Route', 'Fees', 'Signatures', 'Arrives']);
    expect(fl.footer).toMatch(/can never withdraw/);
  });

  it('frees USDC from the stock perps balance first on standard accounts (only what the main balance lacks)', async () => {
    h.fresh = { mode: 'standard', bal: { xyzAvailable: 20.5, mainAvailable: 4.25, positions: [], funded: true } };
    const { f } = relay();
    const { out } = await runAll(flow(f));
    expect(h.approvals).toBe(1); // no agent in this browser yet: the wallet approves one
    expect(h.moves).toEqual(['7.75']);
    expect(out[0]).toMatch(/Moved 7\.75 USDC/);
  });

  it('unified accounts: nothing to move, and the quote must take the USDC from spot', async () => {
    h.fresh = { mode: 'unified', bal: { xyzAvailable: 30, mainAvailable: 0, positions: [], funded: true } };
    const spot = relay({ quote: (q) => (q.steps[1]!.items[0]!.data.action.parameters.sourceDex = 'spot') });
    const plan = validateWithdrawQuote(clone(usdgQuote), { user: USER, to: 'robinhood', asset: 'USDG', amount: AMT, sourceDex: '' });
    await runAll(flow(spot.f, plan));
    expect(h.moves).toEqual([]);
    expect(h.sends[0]!.p.sourceDex).toBe('spot');
    // A quote taking it from the perps balance instead is refused for a unified account.
    h.sends = [];
    const wrong = relay();
    const fl = flow(wrong.f, plan);
    await expect(fl.steps[1]!.run(ctx())).rejects.toThrow(/another balance/);
    expect(h.sends).toHaveLength(0);
  });

  it('refuses more than is free, and a fresh quote below the reviewed minimum, before anything is signed', async () => {
    h.fresh = { mode: 'standard', bal: { xyzAvailable: 3, mainAvailable: 4, positions: [{}], funded: true } };
    const { f } = relay();
    await expect(flow(f).steps[0]!.run(ctx())).rejects.toThrow(/7\.00 USDC free to withdraw, less than 12\.00.*Nothing was sent/);
    h.fresh = { mode: 'standard', bal: { xyzAvailable: 0, mainAvailable: 50, positions: [], funded: true } };
    const plan = usdg();
    const worse = relay({ quote: (q) => (q.details.currencyOut.minimumAmount = String((plan.minOut * 99n) / 100n)) });
    await expect(flow(worse.f, plan).steps[1]!.run(ctx())).rejects.toThrow(/less than the .* you reviewed\. Nothing was sent/);
    expect(h.signed).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
    // A drift of a few millionths (as between two real quotes) goes ahead.
    const drift = relay({ quote: (q) => (q.details.currencyOut.minimumAmount = String(plan.minOut - 3n)) });
    expect(await flow(drift.f, plan).steps[1]!.run(ctx())).toBe('Signed in your wallet');
  });

  it('says a refund plainly', async () => {
    const { f } = relay({ status: ['refund'] });
    const fl = flow(f);
    const c = ctx();
    c.out.sent = true;
    c.out.plan = usdg();
    await expect(fl.steps[3]!.run(c)).rejects.toThrow(/refunded the USDC to you/);
  });
});

describe('withdrawing to Arbitrum', () => {
  it("signs the exchange's own withdrawal of exactly the amount to this address, after freeing it", async () => {
    h.fresh = { mode: 'standard', bal: { xyzAvailable: 10, mainAvailable: 0.5, positions: [], funded: true } };
    const fl = arbWithdrawFlow({ user: USER, amount: 5_500_000n });
    const c = ctx();
    for (const s of fl.steps) await s.run(c);
    expect(h.moves).toEqual(['5']);
    expect(h.withdraws).toEqual([{ destination: USER, amount: '5.5' }]);
    expect(await fl.steps[1]!.run(c)).toBe('Already sent');
    expect(h.withdraws).toHaveLength(1);
    expect(fl.review.find((r) => r[0] === 'You receive')![1]).toBe('4.50 USDC on Arbitrum');
    expect(fl.done(c).toast).toBe('Withdrawal on its way');
  });
});

describe('amounts', () => {
  it('reads typed USDC, free balances and refusals exactly', () => {
    expect(parseUsdc('12.5')).toBe(12_500_000n);
    expect(parseUsdc('0.000001')).toBe(1n);
    expect(parseUsdc('1.0000001')).toBeNull();
    expect(parseUsdc('abc')).toBeNull();
    expect(microExact(12_500_000n)).toBe('12.5');
    expect(microExact(3_000_000n)).toBe('3');
    expect(microText(12_345_678n)).toBe('12.34');
    expect(toMicro(17.023456)).toBe(17_023_456n);
    expect(withdrawableMicro({ xyzAvailable: 10.123456, mainAvailable: 6.9, positions: [], funded: true })).toBe(17_023_456n);
    expect(withdrawRefusal(null, 10n, 'robinhood')).toBe('amount');
    expect(withdrawRefusal(5_000_000n, null, 'robinhood')).toBe('loading');
    expect(withdrawRefusal(5_000_000n, 4_000_000n, 'robinhood')).toBe('balance');
    expect(withdrawRefusal(500_000n, 4_000_000n, 'robinhood')).toBe('min');
    expect(withdrawRefusal(1_500_000n, 4_000_000n, 'arb')).toBe('min');
    expect(withdrawRefusal(1_500_000n, 4_000_000n, 'robinhood')).toBeNull();
    expect(outText('ETH', 6_566_748_055_133_035n)).toBe('0.006566');
    expect(outText('USDG', 11_970_191n)).toBe('11.97');
  });
});
