/**
 * Sends the transactions of one hot key (price relay or keeper): one transaction in flight at a time,
 * nonce taken from the chain, replacement with bumped fees (and a freshly rebuilt payload) when a
 * transaction does not mine, a hard ceiling on the fee per gas, a balance monitor, and the network guard:
 * nothing is ever signed for Robinhood Chain mainnet (4663) without ONCHAIN_MAINNET_CONFIRMED=yes, nor when
 * RPC_URL (or RPC_URL_SEND) serves another chain than the one configured. The guard is checked in every path
 * that signs (submit, replacement, cancellation, nonce-gap fill), and a refused sender adopts nothing at start
 * (on-chain workers audit L-1).
 *
 * One in flight makes the nonce simple and reorg-proof: with nothing pending, the next nonce is the chain's
 * transaction count; a replacement reuses the in-flight nonce. Pending transactions this process does not
 * know (a previous run, another instance) are adopted and cancelled after the stuck timeout.
 *
 * A nonce is never left unused (audit M-1): when the payload replacements run out (maxReplacements) the sender
 * cancels the nonce with 0-value transfers to itself, bumping the fee up to the ceiling, and once no higher fee
 * is allowed it re-broadcasts the newest version, until the nonce is used; meanwhile `stuck` is set and an alert
 * names the nonce. A nonce-gap fill that the node rejects is retried and alerts too. Old signed versions an RPC
 * may hold back can still land later, which is why every price push also expires on chain (OracleAdapter
 * MAX_PUSH_DELAY).
 *
 * Optional second endpoint (RPC_URL_SEND, audit M-1): when given, transactions are broadcast through it and the
 * nonce and receipts are read from it, so an RPC_URL that withholds transactions or answers wrong receipts cannot
 * stall the key; every other read uses RPC_URL.
 *
 * The private key never reaches this module: it gets a viem account (which keeps the key in a closure).
 */
import { ONCHAIN_MAINNET_CHAIN_ID, type SenderStatus } from '@velum/config/src/onchain';
import { keccak256, type Address, type Hex, type TransactionSerializableEIP1559 } from 'viem';
import type { Logger } from '../lib/log';
import { describeError, errorText } from './errors';
import { weiToGwei } from './env';

export interface TxRequest {
  to: Address;
  data: Hex;
  value?: bigint;
  /** Gas limit; estimated (plus 25%) when absent. */
  gas?: bigint;
  /** What the transaction does, for logs and the caller ("push", "liquidate:12", ...). */
  label: string;
}

/** Called before a replacement: the payload to send instead (fresh prices, a re-checked action) or null to cancel. */
export type Rebuild = () => Promise<TxRequest | null>;

export interface SignerAccount {
  address: Address;
  signTransaction(tx: TransactionSerializableEIP1559): Promise<Hex>;
}

export interface MinedReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  transactionHash: Hex;
  gasUsed: bigint;
  logs: ReadonlyArray<{ address: Address; topics: readonly Hex[]; data: Hex; logIndex: number | null }>;
}

/** The read and send calls the sender needs (a viem PublicClient provides them; tests pass a fake). */
export interface SenderChain {
  getChainId(): Promise<number>;
  getTransactionCount(args: { address: Address; blockTag: 'latest' | 'pending' }): Promise<number>;
  getBalance(args: { address: Address }): Promise<bigint>;
  getBlock(args: { blockTag: 'latest' }): Promise<{ baseFeePerGas: bigint | null; timestamp: bigint }>;
  estimateMaxPriorityFeePerGas(): Promise<bigint>;
  estimateGas(args: { account: Address; to: Address; data: Hex; value?: bigint; blockTag?: 'latest' }): Promise<bigint>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
  /** Throws when the transaction has no receipt yet (viem: TransactionReceiptNotFoundError). */
  getTransactionReceipt(args: { hash: Hex }): Promise<MinedReceipt>;
}

/** What the send endpoint (RPC_URL_SEND) is used for: broadcast, nonce and receipts. */
export type SendChain = Pick<SenderChain, 'getChainId' | 'getTransactionCount' | 'sendRawTransaction' | 'getTransactionReceipt'>;

export interface SenderOptions {
  role: 'relayer' | 'keeper';
  chainId: number;
  /** The highest max fee per gas ever offered (RELAYER_MAX_GWEI / KEEPER_MAX_GWEI). */
  maxFeeWei: bigint;
  minBalanceWei: bigint;
  /** ONCHAIN_MAINNET_CONFIRMED=yes. */
  mainnetConfirmed: boolean;
  /** Replace a transaction that has not mined after this long. */
  stuckAfterMs: number;
  maxReplacements?: number;
  balanceEveryMs?: number;
  log: Logger;
  now?: () => number;
  /** RPC_URL_SEND: broadcast, nonce and receipts through this endpoint (default: the read chain). */
  send?: SendChain;
}

export type SubmitResult =
  | { status: 'sent'; hash: Hex; nonce: number }
  | { status: 'busy' }
  | { status: 'refused'; reason: string }
  | { status: 'failed'; error: string };

export type PollResult =
  | { state: 'idle' }
  | { state: 'pending'; hash: Hex | null; stuck: boolean }
  | { state: 'mined'; label: string; receipt: MinedReceipt }
  | { state: 'dropped'; label: string };

interface Inflight {
  nonce: number;
  label: string;
  /** The payload of the newest version; null for a cancellation or a transaction this process did not send. */
  request: TxRequest | null;
  /** A pending transaction this process did not send (adopted at start or found before a send): fees unknown. */
  unknown: boolean;
  rebuild?: Rebuild;
  maxFee: bigint;
  prio: bigint;
  hashes: Hex[];
  /** The signed versions the node accepted (newest last): the newest is re-broadcast once no bump is allowed. */
  raws: Hex[];
  lastSentAt: number;
  replacements: number;
  /** Polls that saw the chain's nonce below this one (a reorg dropped earlier transactions of this key). */
  gapSeen: number;
  /** When the nonce gap was last filled (null: not yet); refilled after stuckAfterMs while it persists. */
  gapFilledAt: number | null;
}

const unknownInflight = (nonce: number, now: number): Inflight => ({
  nonce,
  label: 'unknown',
  request: null,
  unknown: true,
  maxFee: 0n,
  prio: 0n,
  hashes: [],
  raws: [],
  lastSentAt: now,
  replacements: 0,
  gapSeen: 0,
  gapFilledAt: null,
});

const CANCEL_GAS = 21_000n;
const LOW_BALANCE_LOG_EVERY_MS = 10 * 60_000;
const NOT_VERIFIED = 'RPC chain id not verified yet';

/** +12.5% and one wei: above the 10% both geth and Nitro require of a replacement's fee and tip. */
export const bump = (x: bigint): bigint => x + x / 8n + 1n;

export class TxSender {
  readonly address: Address;
  private readonly o: Required<Omit<SenderOptions, 'now' | 'send'>> & { now: () => number };
  private readonly send: SendChain;
  private readonly separateSend: boolean;
  private inflight: Inflight | null = null;
  private rpcChainId: number | null = null;
  private sendChainId: number | null = null;
  private balance: bigint | null = null;
  private balanceAt = 0;
  private lowLoggedAt = 0;
  private gasCapped = false;
  private stuck = false;
  private lastTx: Hex | null = null;
  private lastConfirmedAt: number | null = null;
  private lastError: string | null = null;
  /** The in-flight nonce stays unused after the payload replacements ran out, or at the fee ceiling (M-1). */
  private nonceAlert: string | null = null;
  /** A nonce-gap fill the node rejected (M-1). */
  private gapAlert: string | null = null;

  constructor(
    private readonly chain: SenderChain,
    private readonly account: SignerAccount,
    opts: SenderOptions,
  ) {
    this.address = account.address;
    const { send, ...rest } = opts;
    this.o = { maxReplacements: 6, balanceEveryMs: 60_000, ...rest, now: opts.now ?? Date.now };
    this.send = send ?? chain;
    this.separateSend = send !== undefined && send !== chain;
  }

  /**
   * Why this sender may not send, or null. Mainnet needs ONCHAIN_MAINNET_CONFIRMED=yes; RPC_URL (and RPC_URL_SEND)
   * must serve the configured chain.
   */
  refusal(): string | null {
    const ids = [this.rpcChainId, this.sendChainId];
    const mainnet = this.o.chainId === ONCHAIN_MAINNET_CHAIN_ID || ids.includes(ONCHAIN_MAINNET_CHAIN_ID);
    if (mainnet && !this.o.mainnetConfirmed) return 'Robinhood Chain mainnet: transactions need ONCHAIN_MAINNET_CONFIRMED=yes';
    if (this.rpcChainId === null || (this.separateSend && this.sendChainId === null)) return NOT_VERIFIED;
    if (this.rpcChainId !== this.o.chainId) return `RPC_URL serves chain ${this.rpcChainId}, not ${this.o.chainId}`;
    if (this.separateSend && this.sendChainId !== this.o.chainId) return `RPC_URL_SEND serves chain ${this.sendChainId}, not ${this.o.chainId}`;
    return null;
  }

  get busy(): boolean {
    return this.inflight !== null;
  }

  /**
   * Verify the RPCs' chain ids, adopt pending transactions of this key (only when this sender may send: a refused
   * one never signs, so it must not take over a nonce it would have to cancel), read the balance. Safe to call again.
   */
  async init(): Promise<void> {
    this.rpcChainId = await this.chain.getChainId();
    this.sendChainId = this.separateSend ? await this.send.getChainId() : this.rpcChainId;
    const refusal = this.refusal();
    if (refusal) {
      this.lastError = refusal;
      this.o.log.warn('on-chain sender will not send', { role: this.o.role, address: this.address, reason: refusal });
    } else await this.adoptPending();
    await this.refreshBalance(true).catch((err: unknown) => this.o.log.warn('balance read failed', { role: this.o.role, err: describeError(err) }));
  }

  /** A pending transaction of this key that this process does not track (lowest nonce first) becomes the in-flight one. */
  private async adoptPending(): Promise<boolean> {
    if (this.inflight) return false;
    const [latest, pending] = await Promise.all([
      this.send.getTransactionCount({ address: this.address, blockTag: 'latest' }),
      this.send.getTransactionCount({ address: this.address, blockTag: 'pending' }),
    ]);
    if (pending <= latest) return false;
    this.inflight = unknownInflight(latest, this.o.now());
    this.o.log.warn('found a pending transaction this process did not send; waiting for it, then cancelling it if it does not mine', {
      role: this.o.role,
      address: this.address,
      nonce: latest,
      pending: pending - latest,
    });
    return true;
  }

  /** Current fees capped at the ceiling, or null when the base fee alone is above it. */
  private async fees(): Promise<{ maxFee: bigint; prio: bigint; base: bigint } | null> {
    const block = await this.chain.getBlock({ blockTag: 'latest' });
    const base = block.baseFeePerGas ?? 0n;
    if (base > this.o.maxFeeWei) return null;
    const tip = await this.chain.estimateMaxPriorityFeePerGas().catch(() => 0n);
    const maxFee = base * 2n + tip > this.o.maxFeeWei ? this.o.maxFeeWei : base * 2n + tip;
    const prio = tip > maxFee - base ? maxFee - base : tip;
    return { maxFee, prio, base };
  }

  /** The max fee per gas a transaction sent now would offer (capped at the ceiling), or null above it. */
  async feeQuote(): Promise<bigint | null> {
    return (await this.fees())?.maxFee ?? null;
  }

  private async refreshBalance(force = false): Promise<void> {
    const now = this.o.now();
    if (!force && now - this.balanceAt < this.o.balanceEveryMs) return;
    this.balanceAt = now;
    this.balance = await this.chain.getBalance({ address: this.address });
    if (this.balance < this.o.minBalanceWei) {
      if (now - this.lowLoggedAt >= LOW_BALANCE_LOG_EVERY_MS) {
        this.lowLoggedAt = now;
        this.o.log.warn('hot wallet balance is below the alert threshold; top it up', {
          role: this.o.role,
          address: this.address,
          balanceWei: this.balance.toString(),
          minBalanceWei: this.o.minBalanceWei.toString(),
        });
      }
    } else this.lowLoggedAt = 0;
  }

  /** Signs one transaction; refuses (throws) whenever the network guard does (audit L-1: every signing path). */
  private async sign(req: TxRequest, nonce: number, gas: bigint, maxFee: bigint, prio: bigint): Promise<{ raw: Hex; hash: Hex }> {
    const refusal = this.refusal();
    if (refusal) throw new Error(`refusing to sign: ${refusal}`);
    const raw = await this.account.signTransaction({
      type: 'eip1559',
      chainId: this.o.chainId,
      nonce,
      to: req.to,
      data: req.data,
      value: req.value ?? 0n,
      gas,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: prio,
    });
    return { raw, hash: keccak256(raw) };
  }

  /**
   * The request's gas limit, or an estimate plus 25%. Estimated against the latest block, never the pending
   * state: a node's pending state can already hold the transaction a replacement replaces.
   */
  private async estimate(req: TxRequest): Promise<bigint> {
    if (req.gas) return req.gas;
    const g = await this.chain.estimateGas({ account: this.address, to: req.to, data: req.data, value: req.value, blockTag: 'latest' });
    return (g * 125n) / 100n;
  }

  /**
   * Send `req` unless a transaction is in flight ("busy"). "refused": the network guard, the gas ceiling or a
   * balance too small for the gas; "failed": the estimate reverted or the node rejected the transaction.
   */
  async submit(req: TxRequest, rebuild?: Rebuild): Promise<SubmitResult> {
    if (this.inflight) return { status: 'busy' };
    const refusal = this.refusal();
    if (refusal) return { status: 'refused', reason: refusal };
    try {
      if (await this.adoptPending()) return { status: 'busy' };
      const fees = await this.fees();
      this.gasCapped = fees === null;
      if (!fees) {
        this.lastError = `base fee above the ${weiToGwei(this.o.maxFeeWei)} gwei ceiling`;
        return { status: 'refused', reason: this.lastError };
      }
      const gas = await this.estimate(req);
      await this.refreshBalance();
      if (this.balance !== null && this.balance < gas * fees.maxFee + (req.value ?? 0n)) {
        this.lastError = 'balance too small for the gas';
        await this.refreshBalance(true);
        if (this.balance !== null && this.balance < gas * fees.maxFee + (req.value ?? 0n)) return { status: 'refused', reason: this.lastError };
      }
      const nonce = await this.send.getTransactionCount({ address: this.address, blockTag: 'latest' });
      const { raw, hash } = await this.sign(req, nonce, gas, fees.maxFee, fees.prio);
      // Tracked before sending: if the send times out after the node accepted it, the hash is still watched.
      this.inflight = {
        nonce,
        label: req.label,
        request: { ...req, gas },
        unknown: false,
        rebuild,
        maxFee: fees.maxFee,
        prio: fees.prio,
        hashes: [hash],
        raws: [raw],
        lastSentAt: this.o.now(),
        replacements: 0,
        gapSeen: 0,
        gapFilledAt: null,
      };
      const sent = await this.broadcast(raw);
      if (sent !== 'ok' && sent !== 'unknown') {
        // "underpriced": the node holds another transaction with this nonce that the pending count did not
        // show. Track the nonce as unknown, so poll() replaces (cancels) it after the stuck timeout.
        this.inflight = /underpriced/i.test(sent) ? unknownInflight(nonce, this.o.now()) : null;
        this.lastError = sent;
        return { status: 'failed', error: sent };
      }
      this.lastTx = hash;
      this.lastError = null;
      this.o.log.info('transaction sent', { role: this.o.role, label: req.label, hash, nonce, maxFeeGwei: weiToGwei(fees.maxFee) });
      return { status: 'sent', hash, nonce };
    } catch (err) {
      this.lastError = describeError(err);
      return { status: 'failed', error: this.lastError };
    }
  }

  /** "ok", "unknown" (timeout or network error: the node may have it) or the rejection reason. */
  private async broadcast(raw: Hex): Promise<'ok' | 'unknown' | string> {
    try {
      await this.send.sendRawTransaction({ serializedTransaction: raw });
      return 'ok';
    } catch (err) {
      const text = errorText(err);
      if (text.includes('already known') || text.includes('known transaction')) return 'ok';
      if (/timed? ?out|fetch failed|econnreset|socket hang up|network/.test(text) && !/nonce|underpriced|insufficient|fee/.test(text)) return 'unknown';
      return describeError(err);
    }
  }

  /** The in-flight transaction is over (mined, or its nonce used elsewhere): the alerts about it end. */
  private settle(): void {
    this.inflight = null;
    this.stuck = false;
    this.nonceAlert = null;
    this.gapAlert = null;
  }

  /**
   * Advance the in-flight transaction: "mined" (success or reverted) once a receipt of any of its versions
   * exists, "dropped" when its nonce was used by a transaction this process did not send, otherwise
   * "pending" (replaced with bumped fees, then cancelled, when it has waited longer than stuckAfterMs). Also
   * refreshes the balance once a minute.
   */
  async poll(): Promise<PollResult> {
    await this.refreshBalance().catch((err: unknown) => this.o.log.warn('balance read failed', { role: this.o.role, err: describeError(err) }));
    const f = this.inflight;
    if (!f) {
      this.settle();
      return { state: 'idle' };
    }
    for (const hash of [...f.hashes].reverse()) {
      const receipt = await this.send.getTransactionReceipt({ hash }).catch(() => null);
      if (!receipt) continue;
      this.settle();
      this.lastTx = receipt.transactionHash;
      this.lastConfirmedAt = this.o.now();
      if (receipt.status !== 'success') this.lastError = `${f.label} reverted`;
      await this.refreshBalance(true).catch(() => undefined);
      return { state: 'mined', label: f.label, receipt };
    }
    const latest = await this.send.getTransactionCount({ address: this.address, blockTag: 'latest' });
    if (latest > f.nonce) {
      this.settle();
      if (!f.unknown) this.o.log.warn('nonce used by a transaction this process did not send', { role: this.o.role, label: f.label, nonce: f.nonce });
      return { state: 'dropped', label: f.label };
    }
    if (latest < f.nonce) {
      // Seen twice (a load-balanced RPC may answer once from a node that lags): a reorg dropped earlier
      // transactions of this key, so this one can never mine until the gap is filled. Refilled (at the ceiling)
      // after stuckAfterMs while the gap persists.
      if (++f.gapSeen >= 2 && (f.gapFilledAt === null || this.o.now() - f.gapFilledAt >= this.o.stuckAfterMs)) await this.fillGap(f, latest);
    } else {
      f.gapSeen = 0;
      this.gapAlert = null;
      if (this.o.now() - f.lastSentAt >= this.o.stuckAfterMs) await this.replace(f);
    }
    return { state: 'pending', hash: f.hashes.at(-1) ?? null, stuck: this.stuck };
  }

  /**
   * The in-flight transaction sits above a nonce gap. Its payload must never mine late (a price push would
   * carry old prices), so it is replaced with a cancellation first; then every missing nonce gets a 0-value
   * transfer to self, after which the cancellation mines and sending resumes. A filler the node rejects raises an
   * alert, and the fill is repeated at the fee ceiling while the gap persists (audit M-1).
   */
  private async fillGap(f: Inflight, latest: number): Promise<void> {
    const refusal = this.refusal();
    if (refusal) {
      this.stuck = true;
      this.lastError = refusal;
      return;
    }
    const first = f.gapFilledAt === null;
    f.gapFilledAt = this.o.now();
    (first ? this.o.log.warn : this.o.log.info)('nonce gap below the in-flight transaction (a reorg dropped earlier ones): cancelling it and filling the gap', {
      role: this.o.role,
      label: f.label,
      nonce: f.nonce,
      chainNonce: latest,
      attempt: first ? 1 : 'retry',
    });
    const failures: string[] = [];
    try {
      if (first && (f.request || f.unknown)) await this.replace(f, true);
      let maxFee = this.o.maxFeeWei;
      let prio = this.o.maxFeeWei;
      if (first) {
        const market = await this.fees().catch(() => null);
        maxFee = market && market.maxFee * 2n < this.o.maxFeeWei ? market.maxFee * 2n : this.o.maxFeeWei;
        prio = market && market.prio < maxFee ? market.prio : maxFee;
      }
      for (let n = latest; n < f.nonce; n++) {
        const { raw } = await this.sign({ to: this.address, data: '0x', value: 0n, label: 'gap' }, n, CANCEL_GAS, maxFee, prio);
        const sent = await this.broadcast(raw);
        if (sent !== 'ok' && sent !== 'unknown') failures.push(`nonce ${n}: ${sent}`);
      }
    } catch (err) {
      failures.push(describeError(err));
    }
    if (failures.length) {
      this.gapAlert = `nonce gap ${latest}-${f.nonce - 1} below the in-flight transaction not filled: ${failures[0]}`.slice(0, 200);
      this.stuck = true;
      this.o.log.error('nonce gap filler rejected; retrying at the fee ceiling while the gap persists', { role: this.o.role, nonce: f.nonce, chainNonce: latest, err: failures[0] });
    }
  }

  /** Re-sends the newest signed version (no higher fee is allowed): an RPC or node that dropped it gets it again. */
  private async rebroadcast(f: Inflight): Promise<void> {
    const raw = f.raws.at(-1);
    f.lastSentAt = this.o.now();
    if (!raw) return;
    const sent = await this.broadcast(raw);
    if (sent !== 'ok' && sent !== 'unknown') this.o.log.debug('re-broadcast rejected', { role: this.o.role, nonce: f.nonce, err: sent });
  }

  /**
   * Same nonce, fees bumped by 12.5% (or to the current market, if higher), payload rebuilt, or a cancellation
   * (a 0-value transfer to self) when `cancel` is set, when the rebuild finds nothing to send, or once the payload
   * replacements ran out. Never above the fee ceiling: when no valid bump fits under it, the newest version is
   * re-broadcast instead, so the nonce keeps being offered until it is used (audit M-1).
   */
  private async replace(f: Inflight, cancel = false): Promise<void> {
    const refusal = this.refusal();
    if (refusal) {
      this.stuck = true;
      this.lastError = refusal;
      return;
    }
    const exhausted = f.replacements >= this.o.maxReplacements;
    if (exhausted && !this.nonceAlert) {
      this.o.log.error('transaction still not mined after the maximum number of replacements; cancelling its nonce at up to the fee ceiling until it is used', {
        role: this.o.role,
        label: f.label,
        nonce: f.nonce,
      });
      this.nonceAlert = `nonce ${f.nonce} (${f.label}) not mined after ${this.o.maxReplacements} replacements: cancelling it at up to the ${weiToGwei(this.o.maxFeeWei)} gwei ceiling until it is used`;
    }
    if (exhausted) this.stuck = true;
    let req: TxRequest | null = cancel || exhausted ? null : f.request && f.rebuild ? await f.rebuild().catch(() => f.request) : f.request;
    let gas = CANCEL_GAS;
    if (req) {
      try {
        // A rebuilt payload brings its own gas limit (the caller simulated it); otherwise estimate again.
        gas = await this.estimate(req === f.request ? { ...req, gas: undefined } : req);
      } catch (err) {
        this.o.log.info('replacement payload no longer executes; cancelling instead', { role: this.o.role, label: req.label, err: describeError(err) });
        req = null;
      }
    }
    const send: TxRequest = req ?? { to: this.address, data: '0x', value: 0n, label: f.label.startsWith('cancel:') ? f.label : `cancel:${f.label}` };
    const market = await this.fees().catch(() => null);
    let maxFee: bigint;
    let prio: bigint;
    if (f.unknown) {
      // The original's fees are unknown: offer the ceiling, the best chance to replace it.
      maxFee = this.o.maxFeeWei;
      prio = this.o.maxFeeWei;
    } else {
      prio = bump(f.prio);
      if (market && market.prio > prio) prio = market.prio;
      maxFee = bump(f.maxFee);
      if (market && market.base * 2n + prio > maxFee) maxFee = market.base * 2n + prio;
      if (maxFee > this.o.maxFeeWei) maxFee = this.o.maxFeeWei;
      if (prio > maxFee) prio = maxFee;
    }
    // A node accepts a replacement only with both fees raised by at least 10%: below that, re-broadcast.
    if (!f.unknown && (maxFee < bump(f.maxFee) || prio < bump(f.prio))) {
      if (!this.gasCapped) this.o.log.warn('cannot replace a stuck transaction: bumped fee would exceed the ceiling; re-broadcasting it until its nonce is used', { role: this.o.role, label: f.label, ceilingGwei: weiToGwei(this.o.maxFeeWei) });
      this.gasCapped = true;
      this.stuck = true;
      this.nonceAlert = `nonce ${f.nonce} (${f.label}) not mined at the ${weiToGwei(this.o.maxFeeWei)} gwei fee ceiling: re-broadcasting it until it is used`;
      await this.rebroadcast(f);
      return;
    }
    const { raw, hash } = await this.sign(send, f.nonce, req ? gas : CANCEL_GAS, maxFee, prio);
    f.lastSentAt = this.o.now();
    f.replacements++;
    const sent = await this.broadcast(raw);
    if (sent !== 'ok' && sent !== 'unknown') {
      this.o.log.warn('replacement rejected', { role: this.o.role, label: send.label, nonce: f.nonce, err: sent });
      return;
    }
    f.maxFee = maxFee;
    f.prio = prio;
    f.hashes.push(hash);
    f.raws.push(raw);
    f.label = send.label;
    f.request = req ? { ...req, gas } : null;
    f.unknown = false;
    if (!req) f.rebuild = undefined;
    this.o.log.warn('replaced a transaction that did not mine', { role: this.o.role, label: send.label, nonce: f.nonce, hash, maxFeeGwei: weiToGwei(maxFee), replacement: f.replacements });
  }

  /** Alerts an operator must act on (no secrets): an unused nonce, a failed gap fill. */
  alerts(): string[] {
    return [this.nonceAlert, this.gapAlert].filter((a): a is string => a !== null);
  }

  status(enabled = true): SenderStatus {
    return {
      enabled,
      address: this.address,
      sending: this.refusal() === null,
      balanceWei: this.balance === null ? null : this.balance.toString(),
      balanceLow: this.balance !== null && this.balance < this.o.minBalanceWei,
      inflight: this.inflight !== null,
      stuck: this.stuck,
      gasCapped: this.gasCapped,
      lastTx: this.lastTx,
      lastConfirmedAt: this.lastConfirmedAt,
      error: this.lastError,
      alerts: this.alerts(),
    };
  }

  /** Test and status helper: the in-flight transaction's nonce and hashes. */
  pending(): { nonce: number; hashes: Hex[]; label: string; maxFee: bigint } | null {
    return this.inflight ? { nonce: this.inflight.nonce, hashes: [...this.inflight.hashes], label: this.inflight.label, maxFee: this.inflight.maxFee } : null;
  }
}
