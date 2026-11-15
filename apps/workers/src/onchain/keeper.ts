/**
 * Keeper (Phase 3): its own hot key (KEEPER_PRIVATE_KEY, never the relay key), one transaction in flight, run by
 * the signer process (velum-signer, signer/run.ts; one instance: a lock socket in the signer's home). Everything it
 * acts on comes from the chain itself, never from the indexer's database or Redis, which the app user (api +
 * workers) can write (on-chain audit M-2). Each tick, in order of urgency:
 *  1. liquidations: the open positions (positions.ts: every id below nextPositionId read with getPosition, a sweep
 *     re-reading them in turn), checked with PerpsMarkets.isLiquidatable (which applies the sequencer rules: none
 *     while the sequencer is down, only below MM / 2 during its grace hour), most underwater first;
 *  2. matured forced exits (7 days after the request, from getPosition's exitRequestedAt);
 *  3. advanceFunding for markets with open interest whose funding is older than FUNDING_EPOCH_SECONDS;
 *  4. cover payouts: claimCover for shortfall claims of ended hourly epochs (cover-claims.ts: CoverClaimFiled logs,
 *     confirmed unpaid with the coverClaims view; the contracts have no keeper insurance top-up action: the keeper
 *     top-up is paid inside liquidate, and fundInsurance is a donation).
 * Every action is simulated first (eth_estimateGas, which also gives the gas), so a position someone else
 * already liquidated costs nothing. A liquidation whose estimated gas costs more than its reward is sent only
 * when solvency needs it (the liquidated side below MM / 2, or unable to pay the full penalty) and logged.
 *
 * Throughput (on-chain workers audit L-3): one transaction is in flight at a time, but a tick does not stop at the
 * first action: after each send it polls the receipt every RECEIPT_POLL_MS and sends the next action as soon as the
 * previous one mined, until the actions run out or the tick budget (TICK_BUDGET_MS) is spent. Liquidations go
 * first, the urgent ones (below MM / 2 or unable to pay the full penalty) before the others, then the smallest
 * remaining claim relative to notional. Each candidate's reads go out together (JSON-RPC batched). On a chain with
 * quarter-second blocks that is a few liquidations per second, far above the 200 the 572 s keeper window needs.
 */
import { PERPS_LIMITS, deploymentMarkets, type Deployment, type KeeperStatus, type LowerAddress } from '@velum/config/src/onchain';
import { encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem';
import type { Logger } from '../lib/log';
import { abis } from './chain';
import { CoverClaims, type CoverState } from './cover-claims';
import { describeError, revertName, throttledWarn } from './errors';
import { ChainPositions } from './positions';
import type { PollResult, TxSender } from './tx-sender';

const BPS = 10_000n;
const WAD = 10n ** 18n;

export interface LiquidationInput {
  qty: bigint;
  price: bigint;
  valueScale: bigint;
  takerMargin: bigint;
  makerMargin: bigint;
  /** PerpsMarkets.takerClaimAt(id, price): may be negative. */
  takerClaim: bigint;
  keeperRewardCap: bigint;
  insurance: bigint;
}

export interface LiquidationEconomics {
  liquidatable: boolean;
  takerSide: boolean;
  loserClaim: bigint;
  notional: bigint;
  /** Expected liquidator reward in USDG base units (half the penalty, topped up from insurance). */
  reward: bigint;
  /** Solvency needs it now: the liquidated side is below MM / 2 or cannot pay the full penalty. */
  urgent: boolean;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** PerpsBase._liquidationSide and PerpsLiquidation._liquidationSplit / _liquidateAt, for one position. */
export function liquidationEconomics(i: LiquidationInput): LiquidationEconomics {
  const notional = ceilDiv(i.qty * i.price, i.valueScale);
  const req = ceilDiv(notional * PERPS_LIMITS.maintenanceBps, BPS);
  const half = ceilDiv(notional * PERPS_LIMITS.maintenanceBps, 2n * BPS);
  const makerClaim = i.takerMargin + i.makerMargin - i.takerClaim;
  let takerSide = false;
  let liquidatable = false;
  if (i.takerClaim < req && i.takerClaim <= makerClaim) [liquidatable, takerSide] = [true, true];
  else if (makerClaim < req) liquidatable = true;
  const loserClaim = takerSide ? i.takerClaim : makerClaim;
  const fullPenalty = ceilDiv(notional * PERPS_LIMITS.penaltyBps, BPS);
  const penalty = loserClaim > 0n ? (fullPenalty < loserClaim ? fullPenalty : loserClaim) : 0n;
  let reward = penalty / 2n;
  const target = fullPenalty / 2n < i.keeperRewardCap ? fullPenalty / 2n : i.keeperRewardCap;
  if (reward < target) {
    // Top-up from insurance, within the epoch cap of 10% of the fund (an estimate: other draws may use it).
    const room = i.insurance / 10n;
    reward += target - reward < room ? target - reward : room;
  }
  return { liquidatable, takerSide, loserClaim, notional, reward, urgent: liquidatable && (loserClaim < half || loserClaim < fullPenalty) };
}

/** Gas cost in USDG base units at `ethPriceUsd` dollars per ETH (USDG taken at 1 dollar). */
export function gasCostUsdg(gas: bigint, maxFeeWei: bigint, ethPriceUsd: bigint, usdgDecimals: number): bigint {
  return ceilDiv(gas * maxFeeWei * ethPriceUsd * 10n ** BigInt(usdgDecimals), WAD);
}

export type KeeperClient = Pick<PublicClient, 'readContract' | 'getBlock' | 'estimateContractGas' | 'getBlockNumber' | 'getLogs'> & { request?: PublicClient['request'] };

export interface KeeperDeps {
  client: KeeperClient;
  sender: TxSender;
  deployment: Deployment;
  chainId: number;
  fundingEpochSeconds: number;
  ethPriceUsd: bigint;
  /** Max fee per gas ceiling (the profitability estimate uses the current quote, at most this). */
  maxFeeWei: bigint;
  log: Logger;
  /** CONFIRMATIONS: the cover-claim log scan stays this many blocks behind the head (default 3). */
  confirmations?: number;
  /** Largest eth_getLogs range of the cover-claim scan (INDEXER_CHUNK_BLOCKS, default 2000). */
  chunkBlocks?: number;
  /** Where the cover-claim scan keeps its position across restarts (the signer's own state file), or nothing. */
  state?: CoverState;
  /** Most positions checked per tick (rotating), and ids the sweep re-reads per tick. */
  maxChecks?: number;
  now?: () => number;
  /** How long one tick keeps sending actions (default TICK_BUDGET_MS). */
  tickBudgetMs?: number;
  /** How often a tick polls the receipt of the action it sent (default RECEIPT_POLL_MS). */
  receiptPollMs?: number;
}

/** A tick keeps sending for at most this long (well inside the 30 s role lock and BullMQ's job lock). */
export const TICK_BUDGET_MS = 10_000;
/** Receipt polling within a tick: sub-second, so the next action follows the previous one's block at once. */
export const RECEIPT_POLL_MS = 250;
/** Most cover claims paid per tick. */
const COVER_PER_TICK = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Action =
  | { kind: 'liquidate'; id: bigint; urgent: boolean; reward: bigint; ratio: number }
  | { kind: 'forced_exit'; id: bigint }
  | { kind: 'funding'; market: LowerAddress; symbol: string }
  | { kind: 'cover'; epoch: bigint; account: LowerAddress };

const actionKey = (a: Action): string =>
  a.kind === 'liquidate' || a.kind === 'forced_exit' ? `${a.kind}:${a.id}` : a.kind === 'funding' ? `funding:${a.symbol}` : `cover:${a.epoch}:${a.account}`;

/** Cool-downs after a simulation revert or a sent action, so a tick does not repeat work the chain refuses. */
const COOLDOWN_MS = { revert: 15_000, sent: 30_000 } as const;

export class Keeper {
  private ready = false;
  private valueScale = 0n;
  private keeperRewardCap = 0n;
  private usdgDecimals = 6;
  private readonly positions: ChainPositions;
  private readonly claims: CoverClaims;
  private readonly cooldown = new Map<string, number>();
  private readonly skippedLogged = new Set<string>();
  private lastRunAt: number | null = null;
  private okAt: number | null = null;
  private counts = { liquidations: 0, forcedExits: 0, fundingAdvances: 0, coverPayouts: 0 };
  private readonly now: () => number;
  private readonly warn: (msg: string, data?: Record<string, unknown>) => void;

  constructor(private readonly d: KeeperDeps) {
    this.now = d.now ?? Date.now;
    this.warn = throttledWarn(d.log, 60_000, this.now);
    this.positions = new ChainPositions(d.client, d.deployment, d.maxChecks ?? 200);
    this.claims = new CoverClaims({ client: d.client, deployment: d.deployment, confirmations: d.confirmations ?? 3, chunkBlocks: d.chunkBlocks ?? 2000, log: d.log, state: d.state, now: this.now });
  }

  private perps(): Address {
    return this.d.deployment.contracts.perpsMarkets;
  }

  /** Unix ms of the last tick that ran to the end without an error (audit M-3). */
  get lastOkAt(): number | null {
    return this.okAt;
  }

  async init(): Promise<void> {
    const read = (functionName: 'valueScale' | 'keeperRewardCap') => this.d.client.readContract({ address: this.perps(), abi: abis.perpsMarkets, functionName }) as Promise<bigint>;
    [this.valueScale, this.keeperRewardCap] = await Promise.all([read('valueScale'), read('keeperRewardCap')]);
    this.usdgDecimals = Number(await this.d.client.readContract({ address: this.d.deployment.tokens.USDG!, abi: abis.erc20, functionName: 'decimals' }));
    this.ready = true;
  }

  private cooling(key: string): boolean {
    const until = this.cooldown.get(key);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.cooldown.delete(key);
    return false;
  }

  /**
   * Position ids to check this tick, from the chain (positions.ts): the open ids read for the first time, the next
   * `maxChecks` open ids in rotation, and the matured forced exits (oldest request first).
   */
  private async candidateIds(): Promise<{ ids: bigint[]; forced: bigint[] }> {
    const block = await this.d.client.getBlock({ blockTag: 'latest' });
    const r = await this.positions.refresh(this.d.maxChecks ?? 200, block.timestamp);
    return { ids: [...r.fresh, ...r.rotation], forced: r.forced };
  }

  private async liquidations(batch: bigint[]): Promise<Action[]> {
    const perps = this.perps();
    const flags = await Promise.all(
      batch.map((id) => (this.d.client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'isLiquidatable', args: [id] }) as Promise<boolean>).catch(() => false)),
    );
    const due = batch.filter((_, i) => flags[i]);
    if (!due.length) return [];
    const insurance = (await this.d.client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'insurance' })) as bigint;
    // One price read per market, shared by its candidates; every candidate's reads go out together (batched).
    const prices = new Map<string, Promise<bigint>>();
    const priceOf = (market: Address) => {
      const key = market.toLowerCase();
      if (!prices.has(key)) prices.set(key, this.d.client.readContract({ address: this.d.deployment.contracts.oracle, abi: abis.oracle, functionName: 'price', args: [market] }) as Promise<bigint>);
      return prices.get(key)!;
    };
    const read = async (id: bigint): Promise<Extract<Action, { kind: 'liquidate' }> | null> => {
      try {
        const p = (await this.d.client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'getPosition', args: [id] })) as {
          market: Address;
          qty: bigint;
          takerMargin: bigint;
          makerMargin: bigint;
        };
        const price = await priceOf(p.market);
        const takerClaim = (await this.d.client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'takerClaimAt', args: [id, price] })) as bigint;
        const e = liquidationEconomics({ qty: p.qty, price, valueScale: this.valueScale, takerMargin: p.takerMargin, makerMargin: p.makerMargin, takerClaim, keeperRewardCap: this.keeperRewardCap, insurance });
        const ratio = e.notional > 0n ? Number((e.loserClaim * 1_000_000n) / e.notional) / 1_000_000 : 0;
        return { kind: 'liquidate', id, urgent: e.urgent, reward: e.reward, ratio };
      } catch (err) {
        this.d.log.debug('liquidation candidate unreadable', { id: id.toString(), err: describeError(err) });
        return null;
      }
    };
    const out = (await Promise.all(due.map(read))).filter((a): a is Extract<Action, { kind: 'liquidate' }> => a !== null);
    // By risk: the urgent ones (solvency needs them) first, then the smallest remaining claim relative to notional.
    return out.sort((a, b) => (a.urgent === b.urgent ? a.ratio - b.ratio : a.urgent ? -1 : 1));
  }

  private async fundingActions(): Promise<Action[]> {
    const perps = this.perps();
    const block = await this.d.client.getBlock({ blockTag: 'latest' });
    const out: Action[] = [];
    for (const symbol of deploymentMarkets(this.d.deployment)) {
      const market = this.d.deployment.tokens[symbol]!;
      const m = (await this.d.client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'markets', args: [market] })) as readonly [boolean, bigint, bigint, bigint, bigint, bigint, bigint];
      const [enabled, , longOI, shortOI, , , lastUpdate] = m;
      if (!enabled || longOI + shortOI === 0n) continue;
      if (block.timestamp - lastUpdate >= BigInt(this.d.fundingEpochSeconds)) out.push({ kind: 'funding', market, symbol });
    }
    return out;
  }

  /**
   * Shortfall claims of ended epochs not paid yet (cover-claims.ts): CoverClaimFiled logs read from the chain,
   * confirmed unpaid with coverClaims(epoch, account). Oldest epochs first, at most COVER_PER_TICK.
   */
  private async coverActions(): Promise<Action[]> {
    const perps = this.perps();
    const current = (await this.d.client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'currentCoverEpoch' })) as bigint;
    await this.claims.scan();
    return (await this.claims.due(current, COVER_PER_TICK)).map((c) => ({ kind: 'cover' as const, epoch: c.epoch, account: c.account }));
  }

  private call(a: Action): { functionName: 'liquidate' | 'settleForcedExit' | 'advanceFunding' | 'claimCover'; args: readonly unknown[] } {
    switch (a.kind) {
      case 'liquidate':
        return { functionName: 'liquidate', args: [a.id] };
      case 'forced_exit':
        return { functionName: 'settleForcedExit', args: [a.id] };
      case 'funding':
        return { functionName: 'advanceFunding', args: [a.market] };
      case 'cover':
        return { functionName: 'claimCover', args: [a.epoch, a.account] };
    }
  }

  /** Simulate and estimate gas; null (with a cool-down) when the chain refuses it now. */
  private async simulate(a: Action): Promise<bigint | null> {
    const { functionName, args } = this.call(a);
    try {
      // Against the latest block, never the pending state (which may hold this keeper's own pending call).
      return await this.d.client.estimateContractGas({ address: this.perps(), abi: abis.perpsMarkets, functionName, args: args as never, account: this.d.sender.address, blockTag: 'latest' });
    } catch (err) {
      this.cooldown.set(actionKey(a), this.now() + COOLDOWN_MS.revert);
      this.d.log.debug('keeper action refused by the chain', { action: actionKey(a), reason: revertName(err) ?? describeError(err) });
      return null;
    }
  }

  private onMined(p: Extract<PollResult, { state: 'mined' }>): void {
    const ok = p.receipt.status === 'success';
    const kind = p.label.split(':')[0];
    if (ok) {
      if (kind === 'liquidate') this.counts.liquidations++;
      else if (kind === 'forced_exit') this.counts.forcedExits++;
      else if (kind === 'funding') this.counts.fundingAdvances++;
      else if (kind === 'cover') this.counts.coverPayouts++;
    }
    (ok ? this.d.log.info : this.d.log.warn)(ok ? 'keeper action confirmed' : 'keeper action reverted (someone else was first, or the state changed)', { action: p.label, tx: p.receipt.transactionHash });
  }

  /**
   * Polls the in-flight action until it mined (true) or the deadline passed (false: the next tick follows it).
   * A replacement, when it is stuck, happens inside the sender's poll.
   */
  private async waitMined(deadline: number): Promise<boolean> {
    while (this.d.sender.busy) {
      if (this.now() >= deadline) return false;
      await sleep(this.d.receiptPollMs ?? RECEIPT_POLL_MS);
      const p = await this.d.sender.poll();
      if (p.state === 'mined') this.onMined(p);
    }
    return true;
  }

  /** One tick. Never throws. */
  async tick(): Promise<void> {
    try {
      await this.step();
      this.okAt = this.now();
    } catch (err) {
      this.warn('keeper tick failed', { err: describeError(err) });
    }
  }

  private async step(): Promise<void> {
    if (!this.ready) await this.init();
    const deadline = this.now() + (this.d.tickBudgetMs ?? TICK_BUDGET_MS);
    const p = await this.d.sender.poll();
    if (p.state === 'mined') this.onMined(p);
    this.lastRunAt = this.now();
    // Mainnet without ONCHAIN_MAINNET_CONFIRMED=yes or a wrong RPC: nothing could be sent, so nothing to plan.
    if (this.d.sender.busy || this.d.sender.refusal()) return;
    const [up] = (await this.d.client.readContract({ address: this.d.deployment.contracts.oracle, abi: abis.oracle, functionName: 'sequencerStatus' })) as readonly [boolean, boolean];
    const { ids, forced } = await this.candidateIds();
    const actions: Action[] = [];
    // A failed read of one kind of action never holds up the others (a cover query must not stop liquidations).
    const gather = async (what: string, read: () => Promise<Action[]>) =>
      actions.push(
        ...(await read().catch((err: unknown) => {
          this.warn(`keeper could not read its ${what}`, { err: describeError(err) });
          return [];
        })),
      );
    // isLiquidatable is false while the sequencer is down; skip the reads then.
    if (up) await gather('liquidation candidates', () => this.liquidations(ids));
    actions.push(...forced.map((id) => ({ kind: 'forced_exit' as const, id })));
    await gather('funding markets', () => this.fundingActions());
    await gather('cover claims', () => this.coverActions());
    let fee: bigint | null = null;
    for (const a of actions) {
      if (this.now() >= deadline) return;
      const key = actionKey(a);
      if (this.cooling(key)) continue;
      const gas = await this.simulate(a);
      if (gas === null) continue;
      if (a.kind === 'liquidate') {
        fee ??= (await this.d.sender.feeQuote().catch(() => null)) ?? this.d.maxFeeWei;
        const cost = gasCostUsdg(gas, fee, this.d.ethPriceUsd, this.usdgDecimals);
        if (a.reward < cost) {
          if (!a.urgent) {
            if (!this.skippedLogged.has(key)) this.d.log.info('liquidation not worth its gas yet; waiting', { action: key, rewardUsdg: a.reward.toString(), gasCostUsdg: cost.toString() });
            this.skippedLogged.add(key);
            continue;
          }
          this.d.log.warn('liquidating at a gas loss: needed for solvency', { action: key, rewardUsdg: a.reward.toString(), gasCostUsdg: cost.toString() });
        }
      }
      const { functionName, args } = this.call(a);
      const data = encodeFunctionData({ abi: abis.perpsMarkets, functionName, args: args as never }) as Hex;
      const rebuild = async () => {
        const g = await this.simulate(a);
        return g === null ? null : { to: this.perps(), data, gas: (g * 125n) / 100n, label: key };
      };
      const res = await this.d.sender.submit({ to: this.perps(), data, gas: (gas * 125n) / 100n, label: key }, rebuild);
      if (res.status === 'sent') {
        this.cooldown.set(key, this.now() + COOLDOWN_MS.sent);
        this.skippedLogged.delete(key);
        // Next action as soon as this one mined (L-3); a slow block leaves it to the next tick.
        if (!(await this.waitMined(deadline))) return;
        continue;
      }
      if (res.status === 'refused') {
        this.d.log.debug('keeper action refused by the sender', { action: key, reason: res.reason });
        return;
      }
      if (res.status === 'failed') this.d.log.warn('keeper action not sent', { action: key, err: res.error });
      if (res.status === 'busy') return;
    }
  }

  status(): KeeperStatus {
    const s = this.d.sender.status(true);
    const alerts = [...(s.alerts ?? []), ...this.claims.alerts()].map((a) => a.slice(0, 200)).slice(0, 8);
    return { ...s, alerts, lastRunAt: this.lastRunAt, ...this.counts };
  }
}
