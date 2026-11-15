import { keccak256, parseTransaction, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../lib/log';
import { TxSender, bump, type MinedReceipt, type SenderChain, type SenderOptions } from './tx-sender';

// A throwaway scalar (never a real key).
const KEY = `0x${'0'.repeat(62)}a1` as Hex;
const account = privateKeyToAccount(KEY);
const GWEI = 10n ** 9n;
const TO = '0x000000000000000000000000000000000000beef' as Address;

class FakeChain implements SenderChain {
  chainId = 46630;
  latest = 0;
  /** Pending transactions of the key the node knows about beyond `latest` (not sent by the sender under test). */
  foreignPending = 0;
  balance = 10n ** 18n;
  baseFee: bigint | null = GWEI / 10n;
  tip = GWEI / 100n;
  gasEstimate = 100_000n;
  estimateError: Error | null = null;
  sendError: Error | null = null;
  sent: Array<{ hash: Hex; nonce: number; maxFee: bigint; prio: bigint; to: string; data: Hex; gas: bigint }> = [];
  receipts = new Map<Hex, MinedReceipt>();
  estimates: Array<{ blockTag?: string }> = [];

  async getChainId() {
    return this.chainId;
  }
  async getTransactionCount({ blockTag }: { blockTag: 'latest' | 'pending' }) {
    return blockTag === 'latest' ? this.latest : this.latest + this.foreignPending;
  }
  async getBalance() {
    return this.balance;
  }
  async getBlock() {
    return { baseFeePerGas: this.baseFee, timestamp: 1000n };
  }
  async estimateMaxPriorityFeePerGas() {
    return this.tip;
  }
  async estimateGas(a: { blockTag?: 'latest' }) {
    this.estimates.push({ blockTag: a.blockTag });
    if (this.estimateError) throw this.estimateError;
    return this.gasEstimate;
  }
  async sendRawTransaction({ serializedTransaction }: { serializedTransaction: Hex }) {
    if (this.sendError) throw this.sendError;
    const tx = parseTransaction(serializedTransaction);
    const hash = keccak256(serializedTransaction);
    this.sent.push({ hash, nonce: tx.nonce!, maxFee: tx.maxFeePerGas!, prio: tx.maxPriorityFeePerGas!, to: tx.to!, data: (tx.data ?? '0x') as Hex, gas: tx.gas! });
    return hash;
  }
  async getTransactionReceipt({ hash }: { hash: Hex }): Promise<MinedReceipt> {
    const r = this.receipts.get(hash);
    if (!r) throw new Error('Transaction receipt not found');
    return r;
  }
  mine(hash: Hex, status: 'success' | 'reverted' = 'success') {
    this.receipts.set(hash, { status, blockNumber: 7n, transactionHash: hash, gasUsed: 50_000n, logs: [] });
    this.latest++;
  }
}

function logger() {
  const lines: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const log: Logger = {
    debug: (msg, data) => lines.push({ level: 'debug', msg, data }),
    info: (msg, data) => lines.push({ level: 'info', msg, data }),
    warn: (msg, data) => lines.push({ level: 'warn', msg, data }),
    error: (msg, data) => lines.push({ level: 'error', msg, data }),
  };
  return { log, lines };
}

describe('TxSender', () => {
  let chain: FakeChain;
  let clock: number;
  let logs: ReturnType<typeof logger>;
  const make = (o: Partial<SenderOptions> = {}) =>
    new TxSender(chain, account, { role: 'relayer', chainId: 46630, maxFeeWei: GWEI, minBalanceWei: 10n ** 16n, mainnetConfirmed: false, stuckAfterMs: 5000, log: logs.log, now: () => clock, ...o });

  beforeEach(() => {
    chain = new FakeChain();
    clock = 1_000_000;
    logs = logger();
  });

  it('refuses mainnet (4663) without ONCHAIN_MAINNET_CONFIRMED=yes, and a mismatched or unverified RPC', async () => {
    chain.chainId = 4663;
    const main = make({ chainId: 4663 });
    expect(main.refusal()).toMatch(/RPC chain id not verified|mainnet/);
    await main.init();
    expect(main.refusal()).toMatch(/ONCHAIN_MAINNET_CONFIRMED=yes/);
    expect(await main.submit({ to: TO, data: '0x01', label: 'push' })).toEqual({ status: 'refused', reason: expect.stringMatching(/mainnet/) });
    expect(chain.sent).toHaveLength(0);
    expect(main.status().sending).toBe(false);
    const confirmed = make({ chainId: 4663, mainnetConfirmed: true });
    await confirmed.init();
    expect(confirmed.refusal()).toBeNull();

    // Configured for testnet but RPC_URL serves mainnet: refused even with the flag (the chain id differs).
    const crossed = make({ chainId: 46630, mainnetConfirmed: false });
    await crossed.init();
    expect(crossed.refusal()).toMatch(/mainnet/);
    chain.chainId = 1;
    const other = make();
    await other.init();
    expect(other.refusal()).toMatch(/serves chain 1/);
  });

  it('keeps one transaction in flight; the next nonce comes from the chain once it mined', async () => {
    const s = make();
    await s.init();
    const r1 = await s.submit({ to: TO, data: '0x01', label: 'push' });
    expect(r1).toMatchObject({ status: 'sent', nonce: 0 });
    expect(await s.submit({ to: TO, data: '0x02', label: 'push' })).toEqual({ status: 'busy' });
    expect(await s.poll()).toMatchObject({ state: 'pending' });
    chain.mine(chain.sent[0]!.hash);
    expect(await s.poll()).toMatchObject({ state: 'mined', label: 'push' });
    expect(s.busy).toBe(false);
    const r2 = await s.submit({ to: TO, data: '0x02', label: 'push' });
    expect(r2).toMatchObject({ status: 'sent', nonce: 1 });
    expect(chain.sent[1]!.gas).toBe(125_000n); // estimate + 25%
    expect(chain.estimates.every((e) => e.blockTag === 'latest')).toBe(true);
    expect(s.status()).toMatchObject({ inflight: true, lastTx: chain.sent[1]!.hash, error: null });
  });

  it('never offers more than the gas ceiling, and refuses while the base fee is above it', async () => {
    const s = make({ maxFeeWei: GWEI / 5n });
    await s.init();
    chain.baseFee = GWEI / 8n; // 2 x base + tip is above the ceiling: capped
    await s.submit({ to: TO, data: '0x01', label: 'push' });
    expect(chain.sent[0]!.maxFee).toBe(GWEI / 5n);
    chain.mine(chain.sent[0]!.hash);
    await s.poll();
    chain.baseFee = GWEI;
    expect(await s.submit({ to: TO, data: '0x02', label: 'push' })).toMatchObject({ status: 'refused', reason: expect.stringMatching(/ceiling/) });
    expect(s.status().gasCapped).toBe(true);
  });

  it('replaces a stuck transaction with bumped fees and the rebuilt payload, or cancels it', async () => {
    const s = make();
    await s.init();
    let fresh: Hex | null = '0xbb';
    await s.submit({ to: TO, data: '0xaa', label: 'push' }, async () => (fresh ? { to: TO, data: fresh, gas: 90_000n, label: 'push' } : null));
    clock += 4000;
    await s.poll();
    expect(chain.sent).toHaveLength(1);
    clock += 1000;
    expect(await s.poll()).toMatchObject({ state: 'pending' });
    const [a, b] = chain.sent;
    expect(b!.nonce).toBe(a!.nonce);
    expect(b!.data).toBe('0xbb');
    expect(b!.gas).toBe(90_000n);
    expect(b!.maxFee >= bump(a!.maxFee)).toBe(true);
    expect(b!.prio >= bump(a!.prio)).toBe(true);
    // No market qualifies any more: the next replacement is a cancellation (0 value to self, 21000 gas).
    fresh = null;
    clock += 5000;
    await s.poll();
    const c = chain.sent[2]!;
    expect(c).toMatchObject({ nonce: 0, to: account.address.toLowerCase(), data: '0x', gas: 21_000n });
    expect(c.maxFee >= bump(b!.maxFee)).toBe(true);
    expect(s.pending()!.label).toBe('cancel:push');
    clock += 5000;
    await s.poll();
    expect(chain.sent[3]!.maxFee >= bump(c.maxFee)).toBe(true);
    expect(s.pending()!.label).toBe('cancel:push'); // never "cancel:cancel:…", and known fees keep being bumped
    // The original mined after all: reported, and the sender is free again.
    chain.mine(a!.hash);
    expect(await s.poll()).toMatchObject({ state: 'mined' });
    expect(s.busy).toBe(false);
  });

  it('stops at the ceiling instead of overpaying for a replacement', async () => {
    const s = make({ maxFeeWei: GWEI / 4n });
    await s.init();
    chain.baseFee = GWEI / 10n;
    chain.tip = 0n;
    await s.submit({ to: TO, data: '0xaa', label: 'push' }); // 2 x base = 0.2 gwei
    clock += 5000;
    await s.poll(); // bump to 0.225 gwei
    clock += 5000;
    await s.poll(); // the next bump would be 0.253 > 0.25 (and a smaller one would not replace): stop
    clock += 5000;
    await s.poll();
    expect(chain.sent.map((t) => t.maxFee <= GWEI / 4n)).toEqual([true, true]);
    expect(s.status()).toMatchObject({ stuck: true, gasCapped: true });
    expect(logs.lines.some((l) => /would exceed the ceiling/.test(l.msg))).toBe(true);
  });

  it('adopts a pending transaction it did not send, then cancels it at the ceiling', async () => {
    chain.latest = 4;
    chain.foreignPending = 1;
    const s = make();
    await s.init();
    expect(s.pending()).toMatchObject({ nonce: 4, label: 'unknown' });
    expect(await s.submit({ to: TO, data: '0x01', label: 'push' })).toEqual({ status: 'busy' });
    clock += 5000;
    await s.poll();
    expect(chain.sent[0]).toMatchObject({ nonce: 4, to: account.address.toLowerCase(), maxFee: GWEI, gas: 21_000n });
    // Its nonce is used (by the old transaction, not the cancellation): free again.
    chain.latest = 5;
    chain.foreignPending = 0;
    expect(await s.poll()).toMatchObject({ state: 'dropped' });
    expect(s.busy).toBe(false);
  });

  it('a nonce used elsewhere frees the sender; "nonce too low" fails the send; "underpriced" adopts the nonce', async () => {
    const s = make();
    await s.init();
    await s.submit({ to: TO, data: '0x01', label: 'push' });
    chain.latest = 1; // consumed by a transaction this process does not know
    expect(await s.poll()).toEqual({ state: 'dropped', label: 'push' });
    chain.sendError = new Error('nonce too low: next nonce 3, tx nonce 1');
    expect(await s.submit({ to: TO, data: '0x01', label: 'push' })).toMatchObject({ status: 'failed' });
    expect(s.busy).toBe(false);
    chain.sendError = new Error('replacement transaction underpriced');
    expect(await s.submit({ to: TO, data: '0x01', label: 'push' })).toMatchObject({ status: 'failed' });
    expect(s.pending()).toMatchObject({ nonce: 1, label: 'unknown' });
  });

  it('keeps tracking a transaction whose send timed out (the node may have it)', async () => {
    const s = make();
    await s.init();
    chain.sendError = new Error('The request took too long to respond. timed out');
    const r = await s.submit({ to: TO, data: '0x01', label: 'push' });
    expect(r).toMatchObject({ status: 'sent', nonce: 0 });
    expect(s.busy).toBe(true);
  });

  it('after a reorg drops earlier transactions: cancels the in-flight payload and fills the nonce gap', async () => {
    chain.latest = 5;
    const s = make();
    await s.init();
    await s.submit({ to: TO, data: '0xaa', label: 'push' }, async () => ({ to: TO, data: '0xcc', gas: 90_000n, label: 'push' }));
    chain.latest = 3; // a reorg dropped nonces 3 and 4
    await s.poll(); // seen once: could be a lagging node
    expect(chain.sent).toHaveLength(1);
    await s.poll();
    const after = chain.sent.slice(1);
    expect(after[0]).toMatchObject({ nonce: 5, data: '0x', gas: 21_000n }); // the old push can never mine late
    expect(after.slice(1).map((t) => [t.nonce, t.data])).toEqual([
      [3, '0x'],
      [4, '0x'],
    ]);
    expect(logs.lines.some((l) => /nonce gap/.test(l.msg))).toBe(true);
  });

  it('monitors the balance: warns below the threshold and refuses a send it cannot pay for', async () => {
    chain.balance = 10n ** 15n;
    const s = make();
    await s.init();
    expect(s.status()).toMatchObject({ balanceLow: true, balanceWei: String(10n ** 15n) });
    expect(logs.lines.filter((l) => l.level === 'warn' && /balance is below/.test(l.msg))).toHaveLength(1);
    await s.poll(); // within the minute: no second read, no second warning
    expect(logs.lines.filter((l) => /balance is below/.test(l.msg))).toHaveLength(1);
    chain.balance = 10n ** 12n;
    const poor = make();
    await poor.init();
    expect(await poor.submit({ to: TO, data: '0x01', label: 'push' })).toMatchObject({ status: 'refused', reason: expect.stringMatching(/balance/) });
    // The address is public; no log line ever holds the key.
    expect(JSON.stringify(logs.lines)).not.toContain(KEY.slice(2));
  });

  it('a failed estimate fails the submit without sending', async () => {
    const s = make();
    await s.init();
    chain.estimateError = new Error('execution reverted: NotLiquidatable(7)');
    expect(await s.submit({ to: TO, data: '0x01', label: 'liquidate:7' })).toMatchObject({ status: 'failed' });
    expect(chain.sent).toHaveLength(0);
    expect(s.busy).toBe(false);
  });
});
