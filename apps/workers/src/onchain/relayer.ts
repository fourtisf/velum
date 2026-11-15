/**
 * On-chain price relayer (Phase 3, testnet relay-sourced oracle). Runs every second on BullMQ; pushes every
 * PRICE_PUSH_INTERVAL_MS (8-10 s) the latest authenticated price snapshot of each listed market to
 * OracleAdapter.pushPrices, in one batched transaction, but only prices that are safe to put on chain:
 *  - the snapshot verifies (MAC, docs/02) and parses, and price-relay confirmed it with its source within
 *    RELAY_SNAPSHOT_MAX_AGE_MS (stale snapshots are never re-stamped as fresh on chain);
 *  - it is not a demo (simulated) price, on any network;
 *  - its quote is confirmed and not frozen (QUOTE_FROZEN_AFTER_MS), and the US-equity session is open;
 *  - the market is relay-sourced on chain and the price is inside the adapter's fixed bounds (an
 *    out-of-bounds price is never pushed: the adapter would clamp it and walk the market to the bound);
 *  - on the configured network, the deployment's token is the verified token in packages/config;
 *  - the L2 sequencer is up (OracleAdapter.sequencerStatus);
 * and when the rate limit allows it (relay-math.ts: defer a clamped push while that helps, push to converge
 * otherwise). A stuck push is replaced with the prices of the moment (or cancelled when none qualify), never
 * re-sent with old prices.
 */
import { CHAIN, MAX_SNAPSHOT_BYTES, QUOTE_FROZEN_AFTER_MS, TOKENS, cacheKeys, parseSnapshot, usEquitySession, type MarketSnapshot } from '@velum/config';
import type { CacheMac } from '@velum/config/src/cache-mac';
import { RELAY_MAX_PUSH_GAP_S, RELAY_SNAPSHOT_MAX_AGE_MS, deploymentMarkets, type Deployment, type LowerAddress, type RelayerStatus } from '@velum/config/src/onchain';
import { parseWad } from '@velum/math';
import type { Redis } from 'ioredis';
import { decodeEventLog, encodeFunctionData, type Address, type PublicClient } from 'viem';
import type { Logger } from '../lib/log';
import { abis } from './chain';
import { describeError, throttledWarn } from './errors';
import { decide, type Band, type RelayDecision, type Relayed } from './relay-math';
import type { PollResult, TxRequest, TxSender } from './tx-sender';

/** Gas limit of a push: generous for the storage writes of each market (measured in the end-to-end test). */
export const PUSH_GAS_BASE = 60_000n;
export const PUSH_GAS_PER_MARKET = 60_000n;

export type SkipReason = 'no-snapshot' | 'demo' | 'stale' | 'unconfirmed' | 'frozen' | 'closed' | 'bad-price' | 'bounds' | 'not-relay-sourced' | 'token-mismatch' | 'sequencer-down';

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
export type RelayClient = Pick<PublicClient, 'readContract' | 'getBlock'>;

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

interface Plan {
  push: Array<{ symbol: string; token: LowerAddress; price: bigint }>;
  /** Seconds until the next decision can change (cadence or deferral), or null. */
  waitS: bigint | null;
}

export class PriceRelayer {
  private markets: MarketInfo[] = [];
  private ready = false;
  private disabled: string | null = null;
  private nextCheckAt = 0;
  private readonly reasons = new Map<string, string>();
  private lastPushAt: number | null = null;
  private lastPushBlockTime: number | null = null;
  private sequencerUp: boolean | null = null;
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

  /** What to push now. Reads snapshots, then the chain state of the markets that qualify. */
  async plan(): Promise<Plan> {
    const snaps = await this.snapshots();
    const now = this.now();
    const candidates: Array<{ m: MarketInfo; price: bigint }> = [];
    for (const m of this.markets) {
      if (m.blocked) {
        this.note(m.symbol, m.blocked);
        continue;
      }
      const e = snapshotEligibility(snaps.get(m.symbol), now, this.d.sessionOpen);
      if (!e.ok) this.note(m.symbol, e.reason);
      else if (e.price < m.minPrice || e.price > m.maxPrice) this.note(m.symbol, 'bounds');
      else candidates.push({ m, price: e.price });
    }
    if (!candidates.length) return { push: [], waitS: null };

    const oracle = this.oracle();
    const [block, seq, states] = await Promise.all([
      this.d.client.getBlock({ blockTag: 'latest' }),
      this.d.client.readContract({ address: oracle, abi: abis.oracle, functionName: 'sequencerStatus' }) as Promise<readonly [boolean, boolean]>,
      Promise.all(
        candidates.map(async ({ m }) => {
          const [r, b] = await Promise.all([
            this.d.client.readContract({ address: oracle, abi: abis.oracle, functionName: 'relayed', args: [m.token] }) as Promise<readonly [bigint, bigint]>,
            this.d.client.readContract({ address: oracle, abi: abis.oracle, functionName: 'bands', args: [m.token] }) as Promise<readonly [bigint, bigint, bigint]>,
          ]);
          return { relayed: { price: r[0], updatedAt: r[1] } as Relayed, band: { last: b[0], lastAt: b[1], lastValidAt: b[2] } as Band };
        }),
      ),
    ]);
    this.sequencerUp = seq[0];
    if (!seq[0]) {
      for (const { m } of candidates) this.note(m.symbol, 'sequencer-down');
      return { push: [], waitS: null };
    }
    const t = this.chainNow(block);
    const intervalS = BigInt(Math.ceil(this.d.intervalMs / 1000));
    const push: Plan['push'] = [];
    let waitS: bigint | null = null;
    candidates.forEach(({ m, price }, i) => {
      const s = states[i]!;
      const dec: RelayDecision = decide({ target: price, band: s.band, relayed: s.relayed, t, intervalS, maxGapS: BigInt(RELAY_MAX_PUSH_GAP_S) });
      if (dec.action === 'push') {
        push.push({ symbol: m.symbol, token: m.token, price });
        if (!dec.fits) this.note(m.symbol, 'converging');
      } else {
        // While waiting for the cadence a market keeps its last state ("pushed", "lagging", ...).
        if (dec.reason === 'deferred') this.note(m.symbol, 'deferred');
        else if (!this.reasons.has(m.symbol)) this.note(m.symbol, 'waiting');
        const w = dec.until - t;
        if (waitS === null || w < waitS) waitS = w;
      }
    });
    return { push, waitS };
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
   * The push transaction. Its gas limit is fixed, not estimated: an estimate runs in the context of the latest
   * block, which on an idle chain is this relayer's previous push, so it would revert TooSoon.
   */
  private encode(push: Plan['push']): TxRequest {
    return {
      to: this.oracle(),
      data: encodeFunctionData({ abi: abis.oracle, functionName: 'pushPrices', args: [push.map((p) => p.token), push.map((p) => p.price)] }),
      gas: PUSH_GAS_BASE + PUSH_GAS_PER_MARKET * BigInt(push.length),
      label: `push:${push.map((p) => p.symbol).join(',')}`,
    };
  }

  /** Fresh payload for a replacement: the prices that qualify now, or null (cancel). */
  private async rebuild(): Promise<TxRequest | null> {
    const plan = await this.plan();
    if (!plan.push.length) this.d.log.info('no market qualifies for a push any more; cancelling the stuck push', { markets: Object.fromEntries(this.reasons) });
    return plan.push.length ? this.encode(plan.push) : null;
  }

  private onMined(p: Extract<PollResult, { state: 'mined' }>): void {
    if (p.receipt.status !== 'success') {
      this.d.log.error('price push reverted', { label: p.label, tx: p.receipt.transactionHash });
      return;
    }
    for (const log of p.receipt.logs) {
      if (log.address.toLowerCase() !== this.oracle()) continue;
      try {
        const ev = decodeEventLog({ abi: abis.oracle, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]], strict: true });
        if (ev.eventName !== 'PriceRelayed') continue;
        const m = this.markets.find((x) => x.token === ev.args.token.toLowerCase());
        if (m) this.note(m.symbol, ev.args.price === ev.args.effectivePrice ? 'pushed' : 'lagging');
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
      if (this.disabled) return;
      if (!this.ready) {
        if (this.wallNow() < this.nextCheckAt) return;
        await this.init();
        if (this.disabled) return;
      }
      const p = await this.d.sender.poll();
      if (p.state === 'mined') {
        this.onMined(p);
        this.nextCheckAt = 0;
      }
      if (this.d.sender.busy) return;
      if (this.wallNow() < this.nextCheckAt) return;
      const plan = await this.plan();
      // Re-plan when the earliest waiting market can change, at most once a second (pushes never come
      // closer than the 8 s cadence; a deferral is re-checked every second).
      const waitMs = plan.waitS === null ? 1000 : Math.max(1000, Number(plan.waitS) * 1000 - 500);
      this.nextCheckAt = this.wallNow() + (plan.push.length ? 0 : waitMs);
      if (!plan.push.length) return;
      const res = await this.d.sender.submit(this.encode(plan.push), () => this.rebuild());
      if (res.status === 'failed') this.warn('price push not sent', { err: res.error });
      else if (res.status === 'refused') {
        // Mainnet without ONCHAIN_MAINNET_CONFIRMED=yes, a wrong RPC or the gas ceiling: look again in 10 s.
        this.d.log.debug('price push refused', { reason: res.reason });
        this.nextCheckAt = this.wallNow() + 10_000;
      }
    } catch (err) {
      // An RPC or Redis outage: back off 5 s, warn once a minute.
      this.warn('price relay tick failed', { err: describeError(err) });
      this.nextCheckAt = this.wallNow() + 5000;
    }
  }

  status(): RelayerStatus {
    const s = this.d.sender.status(true);
    return {
      ...s,
      error: this.disabled ?? s.error,
      lastPushAt: this.lastPushAt,
      lastPushBlockTime: this.lastPushBlockTime,
      sequencerUp: this.sequencerUp,
      markets: Object.fromEntries(this.reasons),
    };
  }
}
