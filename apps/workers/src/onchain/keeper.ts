/**
 * Keeper (Phase 3): its own hot key (KEEPER_PRIVATE_KEY, never the relay key), one transaction in flight,
 * one active instance (onchain/lock.ts). Each tick, in order of urgency:
 *  1. liquidations: open positions from the indexer tables (plus ids the indexer has not reached yet, read
 *     from nextPositionId), checked with PerpsMarkets.isLiquidatable (which applies the sequencer rules: none
 *     while the sequencer is down, only below MM / 2 during its grace hour), most underwater first;
 *  2. matured forced exits (7 days after the request);
 *  3. advanceFunding for markets with open interest whose funding is older than FUNDING_EPOCH_SECONDS;
 *  4. cover payouts: claimCover for shortfall claims of ended hourly epochs (the contracts have no keeper
 *     insurance top-up action: the keeper top-up is paid inside liquidate, and fundInsurance is a donation).
 * Every action is simulated first (eth_estimateGas, which also gives the gas), so a position someone else
 * already liquidated costs nothing. A liquidation whose estimated gas costs more than its reward is sent only
 * when solvency needs it (the liquidated side below MM / 2, or unable to pay the full penalty) and logged.
 */
import { PERPS_LIMITS, deploymentMarkets, type Deployment, type KeeperStatus, type LowerAddress } from '@velum/config/src/onchain';
import type { PrismaClient } from '@velum/db';
import { encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem';
import type { Logger } from '../lib/log';
import { abis } from './chain';
import { describeError, revertName, throttledWarn } from './errors';
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

export type KeeperClient = Pick<PublicClient, 'readContract' | 'getBlock' | 'estimateContractGas'>;

export interface KeeperDeps {
  client: KeeperClient;
  sender: TxSender;
  prisma: PrismaClient;
  deployment: Deployment;
  chainId: number;
  fundingEpochSeconds: number;
  ethPriceUsd: bigint;
  /** Max fee per gas ceiling (the profitability estimate uses the current quote, at most this). */
  maxFeeWei: bigint;
  log: Logger;
  /** Most positions checked per tick (rotating). */
  maxChecks?: number;
  now?: () => number;
}

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
  private cursor = 0;
  private readonly cooldown = new Map<string, number>();
  private readonly skippedLogged = new Set<string>();
  private lastRunAt: number | null = null;
  private counts = { liquidations: 0, forcedExits: 0, fundingAdvances: 0, coverPayouts: 0 };
  private readonly now: () => number;
  private readonly warn: (msg: string, data?: Record<string, unknown>) => void;

  constructor(private readonly d: KeeperDeps) {
    this.now = d.now ?? Date.now;
    this.warn = throttledWarn(d.log, 60_000, this.now);
  }

  private perps(): Address {
    return this.d.deployment.contracts.perpsMarkets;
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

  /** Position ids to check: open ones the indexer knows, plus any above the highest indexed id. */
  private async candidateIds(): Promise<{ ids: bigint[]; forced: bigint[] }> {
    const perps = this.perps();
    const rows = await this.d.prisma.perpPosition.findMany({
      where: { chainId: this.d.chainId, perps, status: 'open' },
      select: { positionId: true, exitSettleAfter: true },
      orderBy: { positionId: 'asc' },
    });
    const maxRow = await this.d.prisma.perpPosition.findFirst({ where: { chainId: this.d.chainId, perps }, orderBy: { positionId: 'desc' }, select: { positionId: true } });
    const next = (await this.d.client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'nextPositionId' })) as bigint;
    const ids = rows.map((r) => r.positionId);
    for (let id = (maxRow?.positionId ?? 0n) + 1n; id < next && ids.length < 10_000; id++) ids.push(id);
    const block = await this.d.client.getBlock({ blockTag: 'latest' });
    const nowS = Number(block.timestamp);
    const forced = rows.filter((r) => r.exitSettleAfter && r.exitSettleAfter.getTime() / 1000 <= nowS).map((r) => r.positionId);
    return { ids, forced };
  }

  private async liquidations(ids: bigint[]): Promise<Action[]> {
    const perps = this.perps();
    const max = this.d.maxChecks ?? 200;
    let batch = ids;
    if (ids.length > max) {
      const start = this.cursor % ids.length;
      batch = [...ids.slice(start), ...ids.slice(0, start)].slice(0, max);
      this.cursor = start + max;
    }
    const flags = await Promise.all(
      batch.map((id) => (this.d.client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'isLiquidatable', args: [id] }) as Promise<boolean>).catch(() => false)),
    );
    const due = batch.filter((_, i) => flags[i]);
    if (!due.length) return [];
    const insurance = (await this.d.client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'insurance' })) as bigint;
    const out: Action[] = [];
    for (const id of due) {
      try {
        const p = (await this.d.client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'getPosition', args: [id] })) as {
          market: Address;
          qty: bigint;
          takerMargin: bigint;
          makerMargin: bigint;
        };
        const price = (await this.d.client.readContract({ address: this.d.deployment.contracts.oracle, abi: abis.oracle, functionName: 'price', args: [p.market] })) as bigint;
        const takerClaim = (await this.d.client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'takerClaimAt', args: [id, price] })) as bigint;
        const e = liquidationEconomics({ qty: p.qty, price, valueScale: this.valueScale, takerMargin: p.takerMargin, makerMargin: p.makerMargin, takerClaim, keeperRewardCap: this.keeperRewardCap, insurance });
        const ratio = e.notional > 0n ? Number((e.loserClaim * 1_000_000n) / e.notional) / 1_000_000 : 0;
        out.push({ kind: 'liquidate', id, urgent: e.urgent, reward: e.reward, ratio });
      } catch (err) {
        this.d.log.debug('liquidation candidate unreadable', { id: id.toString(), err: describeError(err) });
      }
    }
    // Most underwater first: the smallest remaining claim relative to notional.
    return out.sort((a, b) => (a.kind === 'liquidate' && b.kind === 'liquidate' ? a.ratio - b.ratio : 0));
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

  /** Shortfall claims of ended epochs not paid yet (from the indexed CoverClaimFiled and CoverPaid events). */
  private async coverActions(): Promise<Action[]> {
    const perps = this.perps();
    const events = await this.d.prisma.chainEvent.findMany({
      where: { chainId: this.d.chainId, address: perps, kind: { in: ['CoverClaimFiled', 'CoverPaid'] } },
      select: { kind: true, data: true },
      orderBy: [{ block: 'asc' }, { logIndex: 'asc' }],
      take: 5000,
    });
    if (!events.length) return [];
    const current = (await this.d.client.readContract({ address: perps, abi: abis.perpsMarkets, functionName: 'currentCoverEpoch' })) as bigint;
    const open = new Map<string, { epoch: bigint; account: LowerAddress }>();
    for (const e of events) {
      const d = e.data as { epoch?: string; account?: string };
      if (!d.epoch || !d.account) continue;
      const key = `${d.epoch}:${d.account}`;
      if (e.kind === 'CoverClaimFiled') open.set(key, { epoch: BigInt(d.epoch), account: d.account as LowerAddress });
      else open.delete(key);
    }
    return [...open.values()].filter((c) => c.epoch < current).slice(0, 5).map((c) => ({ kind: 'cover' as const, ...c }));
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

  /** One tick. Never throws. */
  async tick(): Promise<void> {
    try {
      if (!this.ready) await this.init();
      const p = await this.d.sender.poll();
      if (p.state === 'mined') this.onMined(p);
      this.lastRunAt = this.now();
      // Mainnet without ONCHAIN_MAINNET_CONFIRMED=yes or a wrong RPC: nothing could be sent, so nothing to plan.
      if (this.d.sender.busy || this.d.sender.refusal()) return;
      const [up] = (await this.d.client.readContract({ address: this.d.deployment.contracts.oracle, abi: abis.oracle, functionName: 'sequencerStatus' })) as readonly [boolean, boolean];
      const { ids, forced } = await this.candidateIds();
      const actions: Action[] = [];
      // isLiquidatable is false while the sequencer is down; skip the reads then.
      if (up) actions.push(...(await this.liquidations(ids)));
      actions.push(...forced.map((id) => ({ kind: 'forced_exit' as const, id })));
      actions.push(...(await this.fundingActions()));
      actions.push(...(await this.coverActions()));
      for (const a of actions) {
        const key = actionKey(a);
        if (this.cooling(key)) continue;
        const gas = await this.simulate(a);
        if (gas === null) continue;
        if (a.kind === 'liquidate') {
          const fee = (await this.d.sender.feeQuote().catch(() => null)) ?? this.d.maxFeeWei;
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
          return;
        }
        if (res.status === 'refused') {
          this.d.log.debug('keeper action refused by the sender', { action: key, reason: res.reason });
          return;
        }
        if (res.status === 'failed') this.d.log.warn('keeper action not sent', { action: key, err: res.error });
        if (res.status === 'busy') return;
      }
    } catch (err) {
      this.warn('keeper tick failed', { err: describeError(err) });
    }
  }

  status(): KeeperStatus {
    return { ...this.d.sender.status(true), lastRunAt: this.lastRunAt, ...this.counts };
  }
}
