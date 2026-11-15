/**
 * On-chain price relayer (Phase 3, testnet relay-sourced oracle). Runs every second on BullMQ; pushes every
 * PRICE_PUSH_INTERVAL_MS (8-10 s) the latest authenticated price snapshot of each listed market to
 * OracleAdapter.pushPrices, in one batched transaction, but only prices that are safe to put on chain:
 *  - the snapshot verifies (MAC, docs/02) and parses, and price-relay confirmed it with its source within
 *    RELAY_SNAPSHOT_MAX_AGE_MS (stale snapshots are never re-stamped as fresh on chain);
 *  - it is newer than the snapshot last pushed for that market (audit L-6: observations only move forward);
 *  - it is not a demo (simulated) price, on any network;
 *  - its quote is confirmed and not frozen (QUOTE_FROZEN_AFTER_MS), and the US-equity session is open;
 *  - the market is relay-sourced on chain; a price outside the adapter's fixed bounds is pushed as it is (the
 *    adapter clamps it and the market reads as lagging, IA-06) and raises an alert (audit L-7);
 *  - on the configured network, the deployment's token is the verified token in packages/config;
 *  - the L2 sequencer is up (OracleAdapter.sequencerStatus);
 * and when the rate limit allows it (relay-math.ts: defer a clamped push while that helps, push to converge
 * otherwise). Every push carries its observation time (audit M-1): the chain clock estimate minus the oldest
 * snapshot's age and one second of margin, so the adapter refuses it if it lands more than MAX_PUSH_DELAY
 * (10 s) after the prices were observed. A stuck push is replaced with the prices of the moment (or cancelled
 * when none qualify), never re-sent with old prices. The gas limit comes from eth_estimateGas, which on Arbitrum
 * chains includes the L1 data cost (audit L-4); a reverted push backs off (5 s, doubling to a minute) and alerts.
 */
import { CHAIN, MAX_SNAPSHOT_BYTES, QUOTE_FROZEN_AFTER_MS, TOKENS, cacheKeys, parseSnapshot, usEquitySession, type MarketSnapshot } from '@velum/config';
import type { CacheMac } from '@velum/config/src/cache-mac';
import { RELAY_MAX_PUSH_GAP_S, RELAY_SNAPSHOT_MAX_AGE_MS, deploymentMarkets, type Deployment, type LowerAddress, type RelayerStatus } from '@velum/config/src/onchain';
import { parseWad, toDecimalString } from '@velum/math';
import type { Redis } from 'ioredis';
import { decodeEventLog, encodeFunctionData, type Address, type PublicClient } from 'viem';
import type { Logger } from '../lib/log';
import { abis } from './chain';
import { describeError, throttledWarn } from './errors';
import { decide, type Band, type RelayDecision, type Relayed } from './relay-math';
import type { PollResult, TxRequest, TxSender } from './tx-sender';

/**
 * Execution gas of a push beyond what eth_estimateGas reports for the same calldata sent to the relay's own address
 * (the intrinsic and calldata gas, plus the L1 data cost on Arbitrum chains): generous bounds for the storage writes
 * and the event of each market (a market's first push, zero to non-zero storage, executes in about 57,000 gas in the
 * end-to-end test, which checks 25% headroom).
 */
export const PUSH_EXEC_GAS_BASE = 25_000n;
export const PUSH_EXEC_GAS_PER_MARKET = 60_000n;
/** Margin on the estimated part (the L1 data price moves between the estimate and inclusion). */
const PUSH_ESTIMATE_MARGIN_PCT = 125n;
/** Back-off after a reverted push: 5 s, doubling, at most a minute. */
const REVERT_BACKOFF_MS = { first: 5000, max: 60_000 } as const;
const MAX_ALERTS = 8;

export type SkipReason = 'no-snapshot' | 'demo' | 'stale' | 'unconfirmed' | 'frozen' | 'closed' | 'bad-price' | 'not-relay-sourced' | 'token-mismatch' | 'sequencer-down';

export type Eligibility = { ok: true; price: bigint } | { ok: false; reason: SkipReason };

/**
 * Whether a snapshot may be pushed at wall-clock time `now` (the on-chain checks come later): authenticated
 * and parsed by the caller, not demo, confirmed with its source recently, quote confirmed and not frozen,
 * session open.
 */
export function snapshotEligibility(snap: MarketSnapshot | undefined, now: number, sessionOpen: (t: number) => boolean = (t) => usEquitySession(t).open): Eligibility {
  if (!snap) return { ok: false, reason: 'no-snapshot' };
  if (snap.source === 'demo') return { ok: false, reason: 'demo' };
  if (now - (snap.checkedAt ?? snap.updatedAt) > RELAY_SNAPSHOT_MAX_AGE_MS) return { ok: false, reason: 'stale' };
  if (snap.unconfirmed) return { ok: false, reason: 'unconfirmed' };
  if (now - snap.updatedAt > QUOTE_FROZEN_AFTER_MS) return { ok: false, reason: 'frozen' };
  if (!sessionOpen(now)) return { ok: false, reason: 'closed' };
  const price = parseWad(snap.price);
  if (price === null || price <= 0n) return { ok: false, reason: 'bad-price' };
  return { ok: true, price };
}

/** The relay reads of one tick (a viem PublicClient provides them). */
export type RelayClient = Pick<PublicClient, 'readContract' | 'getBlock' | 'estimateGas'>;

export interface RelayerDeps {
  client: RelayClient;
  sender: TxSender;
  redis: Pick<Redis, 'mget'>;
  mac: CacheMac;
  deployment: Deployment;
  chainId: number;
  intervalMs: number;
  log: Logger;
  /** Clock for the session calendar and snapshot ages (tests inject one). */
  now?: () => number;
  /** Wall clock for estimating the next block's time (default Date.now). */
  wallNow?: () => number;
  sessionOpen?: (t: number) => boolean;
}

interface MarketInfo {
  symbol: string;
  token: LowerAddress;
  minPrice: bigint;
  maxPrice: bigint;
  /** A permanent reason never to push this market, found at start. */
  blocked: SkipReason | null;
}

interface PushItem {
  symbol: string;
  token: LowerAddress;
  price: bigint;
  /** The snapshot's observation (checkedAt, `now` clock, ms). */
  obsMs: number;
}

interface Plan {
  push: PushItem[];
  /** The batch's observation time (chain time, s): what pushPrices gets as observedAt. */
  observedAt: bigint;
  /** Seconds until the next decision can change (cadence or deferral), or null. */
  waitS: bigint | null;
}

const ceilDiv = (a: number, b: number) => Math.ceil(a / b);

export class PriceRelayer {
  private markets: MarketInfo[] = [];
  private ready = false;
  private disabled: string | null = null;
  private nextCheckAt = 0;
  private readonly reasons = new Map<string, string>();
  private lastPushAt: number | null = null;
  private lastPushBlockTime: number | null = null;
  private sequencerUp: boolean | null = null;
  /** The observation (snapshot checkedAt) of the last snapshot sent for each market (audit L-6). */
  private readonly sentObs = new Map<string, number>();
  /** Markets whose quote is outside the adapter's bounds, with the alert text (audit L-7). */
  private readonly boundsAlerts = new Map<string, string>();
  private revertStreak = 0;
  private revertAlert: string | null = null;
  private okAt: number | null = null;
  /** The newest block seen and the wall-clock time it was first seen: the chain clock runs on from it. */
  private ref: { number: bigint; ts: bigint; wallMs: number } | null = null;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly warn: (msg: string, data?: Record<string, unknown>) => void;

  constructor(private readonly d: RelayerDeps) {
    this.now = d.now ?? Date.now;
    this.wallNow = d.wallNow ?? Date.now;
    this.warn = throttledWarn(d.log, 60_000, this.wallNow);
  }

  private oracle(): Address {
    return this.d.deployment.contracts.oracle;
  }

  /** Unix ms (wall clock) of the last tick that ran to the end without an error (audit M-3). */
  get lastOkAt(): number | null {
    return this.okAt;
  }

  /** Reads the relayer address and each market's source configuration. Disables itself on a wrong key. */
  async init(): Promise<void> {
    const relayer = (await this.d.client.readContract({ address: this.oracle(), abi: abis.oracle, functionName: 'relayer' })) as Address;
    if (relayer.toLowerCase() !== this.d.sender.address.toLowerCase()) {
      this.disabled = `PRICE_RELAY_PRIVATE_KEY is ${this.d.sender.address}, but the oracle's relayer is ${relayer}`;
      this.d.log.error('price relayer disabled: the key is not the oracle relayer', { key: this.d.sender.address, relayer });
    }
    const configured = this.d.chainId === CHAIN.id;
    this.markets = await Promise.all(
      deploymentMarkets(this.d.deployment).map(async (symbol): Promise<MarketInfo> => {
        const token = this.d.deployment.tokens[symbol]!;
        const [feed, , minPrice, maxPrice, ok] = (await this.d.client.readContract({ address: this.oracle(), abi: abis.oracle, functionName: 'sources', args: [token] })) as readonly [Address, number, bigint, bigint, boolean];
        let blocked: SkipReason | null = null;
        if (!ok || feed !== '0x0000000000000000000000000000000000000000') blocked = 'not-relay-sourced';
        // Off anvil, the quote is for the verified token in packages/config: never push it for another one.
        const verified = TOKENS[symbol]?.address.toLowerCase();
        if (configured && verified !== token) blocked = 'token-mismatch';
        if (blocked) this.d.log.error('price relayer will not push this market', { symbol, token, reason: blocked });
        return { symbol, token, minPrice, maxPrice, blocked };
      }),
    );
    this.ready = true;
  }

  private async snapshots(): Promise<Map<string, MarketSnapshot>> {
    const keys = this.markets.map((m) => cacheKeys.price(m.symbol));
    const out = new Map<string, MarketSnapshot>();
    if (!keys.length) return out;
    const raws = await this.d.redis.mget(...keys);
    const now = this.now();
    raws.forEach((raw, i) => {
      const m = this.markets[i]!;
      const snap = parseSnapshot(this.d.mac.open(keys[i]!, raw, MAX_SNAPSHOT_BYTES), m.symbol, now);
      if (snap) out.set(m.symbol, snap);
    });
    return out;
  }

  private note(symbol: string, reason: string): void {
    const prev = this.reasons.get(symbol);
    this.reasons.set(symbol, reason);
    if (prev === reason || reason === 'waiting') return;
    const quiet = reason === 'pushed' || reason === 'deferred' || (prev === 'pushed' && reason === 'lagging');
    (quiet ? this.d.log.debug : reason === 'bounds' || reason === 'token-mismatch' ? this.d.log.error : this.d.log.info)('price relay market state', { symbol, state: reason, was: prev ?? null });
  }

  /**
   * What to push now. Reads snapshots, then the chain state of the markets that qualify. `replacing`: the plan
   * replaces the in-flight push, so the snapshot it carries may be sent again (with higher fees); otherwise only a
   * newer one qualifies.
   */
  async plan(replacing = false): Promise<Plan> {
    const snaps = await this.snapshots();
    const now = this.now();
    const candidates: Array<{ m: MarketInfo; price: bigint; clamped: boolean; obsMs: number }> = [];
    for (const m of this.markets) {
      if (m.blocked) {
        this.note(m.symbol, m.blocked);
        continue;
      }
      const snap = snaps.get(m.symbol);
      const e = snapshotEligibility(snap, now, this.d.sessionOpen);
      if (!e.ok) {
        this.note(m.symbol, e.reason);
        this.boundsAlerts.delete(m.symbol);
        continue;
      }
      const obsMs = snap!.checkedAt ?? snap!.updatedAt;
      const sent = this.sentObs.get(m.symbol);
      // Never a snapshot older than the one last sent (L-6); the same one only to replace the in-flight push.
      if (sent !== undefined && (replacing ? obsMs < sent : obsMs <= sent)) continue;
      const clamped = e.price < m.minPrice || e.price > m.maxPrice;
      if (clamped) {
        this.boundsAlerts.set(
          m.symbol,
          `${m.symbol} quote ${toDecimalString(e.price)} is outside the oracle bounds [${toDecimalString(m.minPrice)}, ${toDecimalString(m.maxPrice)}]: pushed as it is, the adapter clamps it and the market reads as lagging`,
        );
      } else this.boundsAlerts.delete(m.symbol);
      candidates.push({ m, price: e.price, clamped, obsMs });
    }
    if (!candidates.length) return { push: [], observedAt: 0n, waitS: null };

    const oracle = this.oracle();
    const [block, seq, states] = await Promise.all([
      this.d.client.getBlock({ blockTag: 'latest' }),
      this.d.client.readContract({ address: oracle, abi: abis.oracle, functionName: 'sequencerStatus' }) as Promise<readonly [boolean, boolean]>,
      Promise.all(
        candidates.map(async ({ m }) => {
          const [r, b] = await Promise.all([
            this.d.client.readContract({ address: oracle, abi: abis.oracle, functionName: 'relayed', args: [m.token] }) as Promise<readonly [bigint, bigint, bigint]>,
            this.d.client.readContract({ address: oracle, abi: abis.oracle, functionName: 'bands', args: [m.token] }) as Promise<readonly [bigint, bigint, bigint]>,
          ]);
          return { relayed: { price: r[0], updatedAt: r[1] } as Relayed, band: { last: b[0], lastAt: b[1], lastValidAt: b[2] } as Band };
        }),
      ),
    ]);
    this.sequencerUp = seq[0];
    if (!seq[0]) {
      for (const { m } of candidates) this.note(m.symbol, 'sequencer-down');
      return { push: [], observedAt: 0n, waitS: null };
    }
    const t = this.chainNow(block);
    const intervalS = BigInt(Math.ceil(this.d.intervalMs / 1000));
    const due: Array<{ item: PushItem; clamped: boolean; fits: boolean; updatedAt: bigint }> = [];
    let waitS: bigint | null = null;
    candidates.forEach(({ m, price, clamped, obsMs }, i) => {
      const s = states[i]!;
      const target = price < m.minPrice ? m.minPrice : price > m.maxPrice ? m.maxPrice : price;
      const dec: RelayDecision = decide({ target, clamped, band: s.band, relayed: s.relayed, t, intervalS, maxGapS: BigInt(RELAY_MAX_PUSH_GAP_S) });
      if (dec.action === 'push') {
        due.push({ item: { symbol: m.symbol, token: m.token, price, obsMs }, clamped, fits: dec.fits, updatedAt: s.relayed.updatedAt });
      } else {
        // While waiting for the cadence a market keeps its last state ("pushed", "lagging", ...).
        if (dec.reason === 'deferred') this.note(m.symbol, 'deferred');
        else if (!this.reasons.has(m.symbol)) this.note(m.symbol, 'waiting');
        const w = dec.until - t;
        if (waitS === null || w < waitS) waitS = w;
      }
    });
    if (!due.length) return { push: [], observedAt: 0n, waitS };
    // The batch's observation: the chain clock estimate minus the oldest snapshot's age (whole seconds, rounded up)
    // and one second against clock skew, so it is never after the push's block time (M-1).
    const oldest = Math.max(0, ...due.map((x) => now - x.item.obsMs));
    const observedAt = t - 1n - BigInt(ceilDiv(oldest, 1000));
    const push: PushItem[] = [];
    for (const x of due) {
      // The adapter refuses a whole batch with an observation not newer than a market's last one.
      if (observedAt <= x.updatedAt) continue;
      push.push(x.item);
      if (x.clamped) this.note(x.item.symbol, 'bounds');
      else if (!x.fits) this.note(x.item.symbol, 'converging');
    }
    return { push, observedAt, waitS };
  }

  /**
   * A lower estimate of the block time a transaction sent now gets: the latest block's time, the chain clock
   * run on at wall-clock speed from the newest block seen (on an idle chain the latest block stands still
   * while the sequencer's clock goes on; a local chain may run ahead of the wall clock), and the wall clock
   * minus 2 s of skew.
   */
  chainNow(block: { number: bigint | null; timestamp: bigint }): bigint {
    const wall = this.wallNow();
    if (block.number !== null && block.number !== this.ref?.number) this.ref = { number: block.number, ts: block.timestamp, wallMs: wall };
    let t = block.timestamp;
    const fromRef = this.ref ? this.ref.ts + BigInt(Math.floor((wall - this.ref.wallMs) / 1000)) : 0n;
    if (fromRef > t) t = fromRef;
    const wallS = BigInt(Math.floor(wall / 1000)) - 2n;
    return wallS > t ? wallS : t;
  }

  /**
   * The push transaction. Its gas limit is eth_estimateGas of the same calldata sent to the relay's own address
   * (intrinsic and calldata gas, plus the L1 data cost on Arbitrum chains), with a margin, plus a fixed bound for the
   * execution (audit L-4). The push itself is not estimated: an estimate runs in the context of the latest block,
   * which on an idle chain is this relayer's previous push, so it would revert TooSoon.
   */
  private async request(plan: Plan): Promise<TxRequest> {
    const { push, observedAt } = plan;
    const data = encodeFunctionData({ abi: abis.oracle, functionName: 'pushPrices', args: [push.map((p) => p.token), push.map((p) => p.price), observedAt] });
    const self = this.d.sender.address;
    const estimated = await this.d.client.estimateGas({ account: self, to: self, data });
    for (const p of push) this.sentObs.set(p.symbol, p.obsMs);
    return {
      to: this.oracle(),
      data,
      gas: (estimated * PUSH_ESTIMATE_MARGIN_PCT) / 100n + PUSH_EXEC_GAS_BASE + PUSH_EXEC_GAS_PER_MARKET * BigInt(push.length),
      label: `push:${push.map((p) => p.symbol).join(',')}`,
    };
  }

  /** Fresh payload for a replacement: the prices that qualify now, or null (cancel). */
  private async rebuild(): Promise<TxRequest | null> {
    const plan = await this.plan(true);
    if (!plan.push.length) this.d.log.info('no market qualifies for a push any more; cancelling the stuck push', { markets: Object.fromEntries(this.reasons) });
    return plan.push.length ? this.request(plan) : null;
  }

  private onMined(p: Extract<PollResult, { state: 'mined' }>): void {
    if (p.receipt.status !== 'success') {
      this.revertStreak++;
      const backoff = Math.min(REVERT_BACKOFF_MS.max, REVERT_BACKOFF_MS.first * 2 ** Math.min(this.revertStreak - 1, 8));
      this.nextCheckAt = this.wallNow() + backoff;
      this.revertAlert = `price push reverted ${this.revertStreak} time(s) in a row (last ${p.receipt.transactionHash}); next try in ${backoff / 1000} s`;
      this.d.log.error('price push reverted; backing off', { label: p.label, tx: p.receipt.transactionHash, streak: this.revertStreak, backoffMs: backoff });
      return;
    }
    this.revertStreak = 0;
    this.revertAlert = null;
    this.nextCheckAt = 0;
    for (const log of p.receipt.logs) {
      if (log.address.toLowerCase() !== this.oracle()) continue;
      try {
        const ev = decodeEventLog({ abi: abis.oracle, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]], strict: true });
        if (ev.eventName !== 'PriceRelayed') continue;
        const m = this.markets.find((x) => x.token === ev.args.token.toLowerCase());
        if (m) this.note(m.symbol, this.boundsAlerts.has(m.symbol) ? 'bounds' : ev.args.price === ev.args.effectivePrice ? 'pushed' : 'lagging');
        this.lastPushBlockTime = Number(ev.args.timestamp);
      } catch {
        /* not an oracle event this version knows */
      }
    }
    this.lastPushAt = this.wallNow();
  }

  /** One tick: follow the in-flight push, then push what is due. Never throws (errors go to the status). */
  async tick(): Promise<void> {
    try {
      await this.step();
      this.okAt = this.wallNow();
    } catch (err) {
      // An RPC or Redis outage: back off 5 s, warn once a minute.
      this.warn('price relay tick failed', { err: describeError(err) });
      this.nextCheckAt = this.wallNow() + 5000;
    }
  }

  private async step(): Promise<void> {
    if (this.disabled) return;
    if (!this.ready) {
      if (this.wallNow() < this.nextCheckAt) return;
      await this.init();
      if (this.disabled) return;
    }
    const p = await this.d.sender.poll();
    if (p.state === 'mined') this.onMined(p);
    if (this.d.sender.busy) return;
    if (this.wallNow() < this.nextCheckAt) return;
    const plan = await this.plan();
    // Re-plan when the earliest waiting market can change, at most once a second (pushes never come
    // closer than the 8 s cadence; a deferral is re-checked every second).
    const waitMs = plan.waitS === null ? 1000 : Math.max(1000, Number(plan.waitS) * 1000 - 500);
    this.nextCheckAt = this.wallNow() + (plan.push.length ? 0 : waitMs);
    if (!plan.push.length) return;
    const res = await this.d.sender.submit(await this.request(plan), () => this.rebuild());
    if (res.status === 'failed') this.warn('price push not sent', { err: res.error });
    else if (res.status === 'refused') {
      // Mainnet without ONCHAIN_MAINNET_CONFIRMED=yes, a wrong RPC or the gas ceiling: look again in 10 s.
      this.d.log.debug('price push refused', { reason: res.reason });
      this.nextCheckAt = this.wallNow() + 10_000;
    }
  }

  status(): RelayerStatus {
    const s = this.d.sender.status(true);
    const alerts = [...(s.alerts ?? []), ...(this.revertAlert ? [this.revertAlert] : []), ...this.boundsAlerts.values()].map((a) => a.slice(0, 200)).slice(0, MAX_ALERTS);
    return {
      ...s,
      error: this.disabled ?? s.error,
      alerts,
      lastPushAt: this.lastPushAt,
      lastPushBlockTime: this.lastPushBlockTime,
      sequencerUp: this.sequencerUp,
      markets: Object.fromEntries(this.reasons),
    };
  }
}
