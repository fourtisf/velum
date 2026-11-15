/**
 * Folds contract events into the Phase 3 tables (packages/db/prisma/schema.prisma). Runs inside the
 * indexer's transaction, in chain order. Idempotent: append-only rows are keyed by (chainId, txHash, logIndex)
 * and inserted with skipDuplicates, state rows (positions, offers, pool reserves) apply an event only when
 * it is newer than the row's (lastBlock, lastLogIndex). After a reorg the indexer deletes everything above the
 * common ancestor and refolds the touched state rows from the ChainEvent rows that remain (rebuildState).
 * Amounts stay integers in base units (DECIMAL(78,0)); the activity feed formats them as exact decimal strings.
 */
import { PERPS_ACTIONS } from '@velum/config/src/onchain-abi';
import { type Deployment, type LowerAddress } from '@velum/config/src/onchain';
import { Prisma } from '@velum/db';
import type { ChainLogEvent, JsonArg, JsonArgs } from './decode';

type Tx = Prisma.TransactionClient;

export interface ProjectionContext {
  chainId: number;
  deployment: Deployment;
  /** Token address -> symbol (from the deployment file). */
  symbols: Map<LowerAddress, string>;
  /** Token address -> decimals (read from the chain). */
  decimals: Map<LowerAddress, number>;
  usdgDecimals: number;
  /** PerpsMarkets.valueScale: qty x price / valueScale = USDG base units. */
  valueScale: bigint;
}

const TAKER_FEE_BPS = 6n;
const BPS = 10_000n;

const D = (v: bigint | string): Prisma.Decimal => new Prisma.Decimal(typeof v === 'bigint' ? v.toString() : v);
const big = (v: JsonArg | undefined): bigint => (typeof v === 'string' && /^-?\d+$/.test(v) ? BigInt(v) : 0n);
const addr = (v: JsonArg | undefined): LowerAddress => (typeof v === 'string' ? v.toLowerCase() : '') as LowerAddress;
const bool = (v: JsonArg | undefined): boolean => v === true || v === 'true';
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** An integer in base units as an exact decimal string ("1500000", 6 -> "1.5"). */
export function fmtUnits(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const s = frac ? `${a / base}.${frac}` : `${a / base}`;
  return neg && a !== 0n ? `-${s}` : s;
}

const isAfter = (row: { lastBlock: bigint; lastLogIndex: number }, ev: ChainLogEvent): boolean =>
  ev.block > row.lastBlock || (ev.block === row.lastBlock && ev.logIndex > row.lastLogIndex);

/** The ChainEvent row of an event (`market` is the token the event is about, when it names one). */
export function chainEventRow(chainId: number, ev: ChainLogEvent): Prisma.ChainEventCreateManyInput {
  const market = ev.args.market ?? ev.args.token ?? ev.args.stock;
  return {
    chainId,
    kind: ev.kind,
    address: ev.address,
    market: typeof market === 'string' ? market : null,
    txHash: ev.txHash,
    logIndex: ev.logIndex,
    block: ev.block,
    at: ev.at,
    data: ev.args as Prisma.InputJsonValue,
  };
}

/** Rows collected while folding one batch, inserted at its end. */
interface Batch {
  trades: Prisma.PerpTradeCreateManyInput[];
  funding: Prisma.FundingPointCreateManyInput[];
  swaps: Prisma.SpotSwapCreateManyInput[];
  liquidity: Prisma.SpotLiquidityCreateManyInput[];
  transfers: Prisma.VaultTransferCreateManyInput[];
  activity: Prisma.AccountActivityCreateManyInput[];
}

class Folder {
  constructor(
    private readonly tx: Tx,
    private readonly c: ProjectionContext,
    private readonly events: ChainLogEvent[],
    private readonly b: Batch,
  ) {}

  private sym(token: string): string | null {
    return this.c.symbols.get(token as LowerAddress) ?? null;
  }

  private units(token: string, v: bigint): string {
    return fmtUnits(v, this.c.decimals.get(token as LowerAddress) ?? 18);
  }

  private usdg(v: bigint): string {
    return fmtUnits(v, this.c.usdgDecimals);
  }

  private activity(ev: ChainLogEvent, accounts: Array<string | null | undefined>, kind: string, data: Record<string, unknown>, extra: { market?: string | null; positionId?: bigint | null } = {}): void {
    const seen = new Set<string>();
    for (const a of accounts) {
      if (!a || seen.has(a)) continue;
      seen.add(a);
      this.b.activity.push({
        chainId: this.c.chainId,
        txHash: ev.txHash,
        logIndex: ev.logIndex,
        account: a,
        contract: ev.address,
        kind,
        market: extra.market ?? null,
        symbol: extra.market ? this.sym(extra.market) : null,
        positionId: extra.positionId ?? null,
        data: data as Prisma.InputJsonValue,
        block: ev.block,
        at: ev.at,
      });
    }
  }

  /** The maker offer fill of an open: OfferFilled earlier in the same transaction. */
  private offerFill(ev: ChainLogEvent): { offerId: bigint; fillSize: bigint } | null {
    let found: ChainLogEvent | null = null;
    for (const e of this.events) {
      if (e.txHash === ev.txHash && e.contract === 'makerBook' && e.kind === 'OfferFilled' && e.logIndex < ev.logIndex) found = e;
    }
    return found ? { offerId: big(found.args.id), fillSize: big(found.args.fillSize) } : null;
  }

  async apply(ev: ChainLogEvent): Promise<void> {
    const a = ev.args;
    switch (`${ev.contract}:${ev.kind}`) {
      case 'perpsMarkets:PositionChanged':
        return this.positionChanged(ev);
      case 'perpsMarkets:PositionSettled':
        return this.positionSettled(ev);
      case 'perpsMarkets:Liquidated':
        return this.liquidated(ev);
      case 'perpsMarkets:ForcedExitRequested':
        return this.forcedExitRequested(ev);
      case 'perpsMarkets:ForcedExitSettled':
        return this.updatePosition(ev, { exitAtEntry: bool(a.atEntryPrice) });
      case 'perpsMarkets:FundingAdvanced':
        this.b.funding.push({
          chainId: this.c.chainId,
          txHash: ev.txHash,
          logIndex: ev.logIndex,
          perps: ev.address,
          market: addr(a.market),
          symbol: this.sym(addr(a.market)),
          rate: D(big(a.rate)),
          index: D(big(a.index)),
          timestamp: new Date(Number(big(a.timestamp)) * 1000),
          block: ev.block,
        });
        return;
      case 'perpsMarkets:BondRefundDeferred':
        return this.activity(ev, [addr(a.account)], 'bond_refund', { amountEth: fmtUnits(big(a.amount), 18) });
      case 'perpsMarkets:BondClaimed':
        return this.activity(ev, [addr(a.account)], 'bond_claimed', { amountEth: fmtUnits(big(a.amount), 18) });
      case 'perpsMarkets:InsuranceFunded':
        return this.activity(ev, [addr(a.from)], 'insurance_funded', { amount: this.usdg(big(a.amount)) });
      case 'perpsMarkets:CoverClaimFiled':
        return this.activity(ev, [addr(a.account)], 'cover_claim', { epoch: String(a.epoch), amount: this.usdg(big(a.amount)) });
      case 'perpsMarkets:CoverPaid':
        return this.activity(ev, [addr(a.account)], 'cover_paid', { epoch: String(a.epoch), claim: this.usdg(big(a.claim)), paid: this.usdg(big(a.paid)) });
      case 'makerBook:OfferPosted':
        return this.offerPosted(ev);
      case 'makerBook:OfferFilled':
        return this.offerFilled(ev);
      case 'makerBook:OfferWithdrawn':
        return this.offerWithdrawn(ev);
      case 'spotPools:PoolChanged':
        return this.poolChanged(ev);
      case 'spotPools:Swapped': {
        const [tin, tout] = [addr(a.tokenIn), addr(a.tokenOut)];
        this.b.swaps.push({ chainId: this.c.chainId, txHash: ev.txHash, logIndex: ev.logIndex, pools: ev.address, account: addr(a.account), tokenIn: tin, tokenOut: tout, amountIn: D(big(a.amountIn)), amountOut: D(big(a.amountOut)), block: ev.block, at: ev.at });
        return this.activity(ev, [addr(a.account)], 'swap', {
          tokenIn: this.sym(tin) ?? tin,
          tokenOut: this.sym(tout) ?? tout,
          amountIn: this.units(tin, big(a.amountIn)),
          amountOut: this.units(tout, big(a.amountOut)),
        });
      }
      case 'spotPools:LiquidityAdded':
      case 'spotPools:LiquidityRemoved': {
        const kind = ev.kind === 'LiquidityAdded' ? 'add' : 'remove';
        const stock = addr(a.stock);
        this.b.liquidity.push({ chainId: this.c.chainId, txHash: ev.txHash, logIndex: ev.logIndex, pools: ev.address, kind, account: addr(a.account), stock, stockAmount: D(big(a.stockAmount)), usdgAmount: D(big(a.usdgAmount)), shares: D(big(a.shares)), block: ev.block, at: ev.at });
        return this.activity(ev, [addr(a.account)], `liquidity_${kind}`, { stockAmount: this.units(stock, big(a.stockAmount)), usdgAmount: this.usdg(big(a.usdgAmount)), shares: big(a.shares).toString() }, { market: stock });
      }
      case 'vault:Deposited':
      case 'vault:Withdrawn': {
        const kind = ev.kind === 'Deposited' ? 'deposit' : 'withdraw';
        const token = addr(a.token);
        const [from, to] = [addr(a.from), addr(a.to)];
        this.b.transfers.push({ chainId: this.c.chainId, txHash: ev.txHash, logIndex: ev.logIndex, vault: ev.address, kind, from, to, token, amount: D(big(a.amount)), block: ev.block, at: ev.at });
        return this.activity(ev, [from, to], kind, { token: this.sym(token) ?? token, amount: this.units(token, big(a.amount)), from, to });
      }
      case 'vault:ModuleApproval': {
        const module = addr(a.module);
        const name = Object.entries(this.c.deployment.contracts).find(([, v]) => v === module)?.[0] ?? module;
        return this.activity(ev, [addr(a.account)], 'approval', { module: name, approved: bool(a.approved) });
      }
      default:
        // Setup, PriceRelayed, InternalTransfer, CloseOnlySet, CoverEpochSettled and unknown events: ChainEvent only.
        return;
    }
  }

  private key(ev: ChainLogEvent, id: bigint) {
    return { chainId_perps_positionId: { chainId: this.c.chainId, perps: ev.address, positionId: id } };
  }

  private async updatePosition(ev: ChainLogEvent, data: Prisma.PerpPositionUpdateInput): Promise<void> {
    const row = await this.tx.perpPosition.findUnique({ where: this.key(ev, big(ev.args.id)) });
    if (!row || !isAfter(row, ev)) return;
    await this.tx.perpPosition.update({ where: this.key(ev, row.positionId), data: { ...data, lastBlock: ev.block, lastLogIndex: ev.logIndex } });
  }

  private async positionChanged(ev: ChainLogEvent): Promise<void> {
    const a = ev.args;
    const id = big(a.id);
    const action = PERPS_ACTIONS[Number(big(a.action))] ?? 'open';
    const market = addr(a.market);
    const [taker, maker] = [addr(a.taker), addr(a.maker)];
    const row = await this.tx.perpPosition.findUnique({ where: this.key(ev, id) });
    if (row && !isAfter(row, ev)) return;
    const state = {
      market,
      symbol: this.sym(market),
      taker,
      maker,
      isLong: bool(a.isLong),
      qty: D(big(a.qty)),
      entry: D(big(a.entry)),
      takerMargin: D(big(a.takerMargin)),
      makerMargin: D(big(a.makerMargin)),
      lastBlock: ev.block,
      lastLogIndex: ev.logIndex,
    };
    const status = action === 'close' ? 'closed' : action === 'liquidate' ? 'liquidated' : action === 'forced_exit' ? 'forced_exit' : 'open';
    const closing = status !== 'open';
    const closeFields = closing ? { closedBlock: ev.block, closedAt: ev.at, closeTx: ev.txHash, closePrice: D(big(a.price)) } : {};
    if (!row) {
      const fill = action === 'open' ? this.offerFill(ev) : null;
      await this.tx.perpPosition.create({
        data: {
          chainId: this.c.chainId,
          perps: ev.address,
          positionId: id,
          ...state,
          status,
          size: fill ? D(fill.fillSize) : null,
          offerId: fill?.offerId ?? null,
          openedBlock: ev.block,
          openedAt: ev.at,
          openTx: ev.txHash,
          ...closeFields,
        },
      });
      if (action === 'open') {
        const qty = big(a.qty);
        const entry = big(a.entry);
        const size = fill?.fillSize ?? (qty * entry) / this.c.valueScale;
        this.b.trades.push({
          chainId: this.c.chainId,
          txHash: ev.txHash,
          logIndex: ev.logIndex,
          perps: ev.address,
          positionId: id,
          kind: 'open',
          market,
          symbol: this.sym(market),
          taker,
          maker,
          isLong: bool(a.isLong),
          qty: D(qty),
          price: D(entry),
          notional: D(size),
          fee: D(fill ? ceilDiv(fill.fillSize * TAKER_FEE_BPS, BPS) : 0n),
          offerId: fill?.offerId ?? null,
          block: ev.block,
          at: ev.at,
        });
      }
    } else {
      await this.tx.perpPosition.update({ where: this.key(ev, id), data: { ...state, ...(row.status === 'open' ? { status } : {}), ...(row.status === 'open' ? closeFields : {}) } });
    }
    const side = bool(a.isLong) ? 'long' : 'short';
    const data = (role: string) => ({
      positionId: id.toString(),
      role,
      side,
      qty: fmtUnits(big(a.qty), 18),
      entry: fmtUnits(big(a.entry), 18),
      takerMargin: this.usdg(big(a.takerMargin)),
      makerMargin: this.usdg(big(a.makerMargin)),
      price: fmtUnits(big(a.price), 18),
    });
    this.activity(ev, [taker], `position_${action}`, data('taker'), { market, positionId: id });
    if (maker !== taker) this.activity(ev, [maker], `position_${action}`, data('maker'), { market, positionId: id });
  }

  private async positionSettled(ev: ChainLogEvent): Promise<void> {
    const a = ev.args;
    const id = big(a.id);
    const row = await this.tx.perpPosition.findUnique({ where: this.key(ev, id) });
    if (!row || !isAfter(row, ev)) return;
    const exitPrice = big(a.exitPrice);
    await this.tx.perpPosition.update({
      where: this.key(ev, id),
      data: {
        exitPrice: D(exitPrice),
        takerPnl: D(big(a.takerPnl)),
        takerFunding: D(big(a.takerFunding)),
        fee: D(big(a.fee)),
        takerOut: D(big(a.takerOut)),
        makerOut: D(big(a.makerOut)),
        lastBlock: ev.block,
        lastLogIndex: ev.logIndex,
      },
    });
    const qty = BigInt(row.qty.toFixed());
    const kind = row.status === 'liquidated' ? 'liquidation' : row.status === 'forced_exit' ? 'forced_exit' : 'close';
    this.b.trades.push({
      chainId: this.c.chainId,
      txHash: ev.txHash,
      logIndex: ev.logIndex,
      perps: ev.address,
      positionId: id,
      kind,
      market: row.market,
      symbol: row.symbol,
      taker: row.taker,
      maker: row.maker,
      isLong: row.isLong,
      qty: D(qty),
      price: D(exitPrice),
      notional: D((qty * exitPrice) / this.c.valueScale),
      fee: D(big(a.fee)),
      offerId: row.offerId,
      block: ev.block,
      at: ev.at,
    });
    const common = { positionId: id.toString(), kind, exitPrice: fmtUnits(exitPrice, 18), fee: this.usdg(big(a.fee)) };
    this.activity(ev, [row.taker], 'position_settled', { ...common, role: 'taker', payout: this.usdg(big(a.takerOut)), pnl: this.usdg(big(a.takerPnl)), funding: this.usdg(big(a.takerFunding)) }, { market: row.market, positionId: id });
    if (row.maker !== row.taker) this.activity(ev, [row.maker], 'position_settled', { ...common, role: 'maker', payout: this.usdg(big(a.makerOut)) }, { market: row.market, positionId: id });
  }

  private async liquidated(ev: ChainLogEvent): Promise<void> {
    const a = ev.args;
    const id = big(a.id);
    const takerSide = bool(a.takerSide);
    const row = await this.tx.perpPosition.findUnique({ where: this.key(ev, id) });
    if (row && isAfter(row, ev)) {
      await this.tx.perpPosition.update({
        where: this.key(ev, id),
        data: {
          liquidator: addr(a.liquidator),
          liquidatedSide: takerSide ? 'taker' : 'maker',
          liquidationPrice: D(big(a.price)),
          penalty: D(big(a.penalty)),
          reward: D(big(a.reward)),
          shortfall: D(big(a.shortfall)),
          lastBlock: ev.block,
          lastLogIndex: ev.logIndex,
        },
      });
    }
    this.activity(ev, [addr(a.liquidator)], 'liquidation_reward', { positionId: id.toString(), side: takerSide ? 'taker' : 'maker', price: fmtUnits(big(a.price), 18), reward: this.usdg(big(a.reward)), shortfall: this.usdg(big(a.shortfall)) }, { market: row?.market ?? null, positionId: id });
  }

  private async forcedExitRequested(ev: ChainLogEvent): Promise<void> {
    const a = ev.args;
    const id = big(a.id);
    const settleAfter = new Date(Number(big(a.settleAfter)) * 1000);
    const row = await this.tx.perpPosition.findUnique({ where: this.key(ev, id) });
    if (!row || !isAfter(row, ev)) return;
    await this.tx.perpPosition.update({ where: this.key(ev, id), data: { exitRequester: addr(a.requester), exitRequestedAt: ev.at, exitSettleAfter: settleAfter, lastBlock: ev.block, lastLogIndex: ev.logIndex } });
    this.activity(ev, [row.taker, row.maker], 'forced_exit_requested', { positionId: id.toString(), requester: addr(a.requester), settleAfter: settleAfter.getTime() }, { market: row.market, positionId: id });
  }

  private offerKey(ev: ChainLogEvent, id: bigint) {
    return { chainId_book_offerId: { chainId: this.c.chainId, book: ev.address, offerId: id } };
  }

  private async offerPosted(ev: ChainLogEvent): Promise<void> {
    const a = ev.args;
    const id = big(a.id);
    const existing = await this.tx.makerOffer.findUnique({ where: this.offerKey(ev, id) });
    if (existing) return;
    const market = addr(a.market);
    await this.tx.makerOffer.create({
      data: {
        chainId: this.c.chainId,
        book: ev.address,
        offerId: id,
        maker: addr(a.maker),
        market,
        symbol: this.sym(market),
        backingPosted: D(big(a.backing)),
        backing: D(big(a.backing)),
        largestFill: D(big(a.largestFill)),
        openSpreadBps: Number(big(a.openSpreadBps)),
        closeSpreadBps: Number(big(a.closeSpreadBps)),
        expiry: new Date(Number(big(a.expiry)) * 1000),
        active: true,
        postedBlock: ev.block,
        postedAt: ev.at,
        postTx: ev.txHash,
        lastBlock: ev.block,
        lastLogIndex: ev.logIndex,
      },
    });
    this.activity(ev, [addr(a.maker)], 'offer_posted', { offerId: id.toString(), backing: this.usdg(big(a.backing)), largestFill: this.usdg(big(a.largestFill)), openSpreadBps: Number(big(a.openSpreadBps)), closeSpreadBps: Number(big(a.closeSpreadBps)), expiry: Number(big(a.expiry)) * 1000 }, { market });
  }

  private async offerFilled(ev: ChainLogEvent): Promise<void> {
    const a = ev.args;
    const id = big(a.id);
    const row = await this.tx.makerOffer.findUnique({ where: this.offerKey(ev, id) });
    if (!row || !isAfter(row, ev)) return;
    await this.tx.makerOffer.update({ where: this.offerKey(ev, id), data: { backing: D(big(a.backingLeft)), fills: { increment: 1 }, lastBlock: ev.block, lastLogIndex: ev.logIndex } });
    this.activity(ev, [row.maker], 'offer_filled', { offerId: id.toString(), fillSize: this.usdg(big(a.fillSize)), makerMargin: this.usdg(big(a.makerMargin)), backingLeft: this.usdg(big(a.backingLeft)) }, { market: row.market });
  }

  private async offerWithdrawn(ev: ChainLogEvent): Promise<void> {
    const a = ev.args;
    const id = big(a.id);
    const row = await this.tx.makerOffer.findUnique({ where: this.offerKey(ev, id) });
    if (!row || !isAfter(row, ev)) return;
    await this.tx.makerOffer.update({ where: this.offerKey(ev, id), data: { active: false, backing: D(0n), returned: D(big(a.returned)), lastBlock: ev.block, lastLogIndex: ev.logIndex } });
    this.activity(ev, [row.maker], 'offer_withdrawn', { offerId: id.toString(), returned: this.usdg(big(a.returned)) }, { market: row.market });
  }

  private async poolChanged(ev: ChainLogEvent): Promise<void> {
    const a = ev.args;
    const stock = addr(a.stock);
    const key = { chainId_pools_stock: { chainId: this.c.chainId, pools: ev.address, stock } };
    const row = await this.tx.spotPoolState.findUnique({ where: key });
    if (row && !isAfter(row, ev)) return;
    const data = { symbol: this.sym(stock), stockReserve: D(big(a.stockReserve)), usdgReserve: D(big(a.usdgReserve)), totalShares: D(big(a.totalShares)), at: ev.at, lastBlock: ev.block, lastLogIndex: ev.logIndex };
    await this.tx.spotPoolState.upsert({ where: key, create: { chainId: this.c.chainId, pools: ev.address, stock, ...data }, update: data });
  }
}

/**
 * Folds `events` (one indexed range, or the remaining events of rebuilt rows, in chain order) into the
 * tables. `storeRaw` also writes the ChainEvent rows (false when refolding rows that are already stored).
 */
export async function applyEvents(tx: Tx, ctx: ProjectionContext, events: ChainLogEvent[], storeRaw = true): Promise<void> {
  if (!events.length) return;
  if (storeRaw) await tx.chainEvent.createMany({ data: events.map((e) => chainEventRow(ctx.chainId, e)), skipDuplicates: true });
  const b: Batch = { trades: [], funding: [], swaps: [], liquidity: [], transfers: [], activity: [] };
  const folder = new Folder(tx, ctx, events, b);
  for (const ev of events) if (ev.known) await folder.apply(ev);
  if (b.trades.length) await tx.perpTrade.createMany({ data: b.trades, skipDuplicates: true });
  if (b.funding.length) await tx.fundingPoint.createMany({ data: b.funding, skipDuplicates: true });
  if (b.swaps.length) await tx.spotSwap.createMany({ data: b.swaps, skipDuplicates: true });
  if (b.liquidity.length) await tx.spotLiquidity.createMany({ data: b.liquidity, skipDuplicates: true });
  if (b.transfers.length) await tx.vaultTransfer.createMany({ data: b.transfers, skipDuplicates: true });
  if (b.activity.length) await tx.accountActivity.createMany({ data: b.activity, skipDuplicates: true });
}

/** A stored ChainEvent row back as an event (for refolding after a reorg). */
export function eventFromRow(row: { kind: string; address: string | null; txHash: string; logIndex: number; block: bigint; at: Date | null; data: Prisma.JsonValue }, names: Map<LowerAddress, string>): ChainLogEvent {
  const address = (row.address ?? '') as LowerAddress;
  return {
    address,
    contract: names.get(address) ?? 'other',
    kind: row.kind,
    known: !row.kind.startsWith('unknown:'),
    args: (row.data ?? {}) as JsonArgs,
    block: row.block,
    blockHash: '0x',
    logIndex: row.logIndex,
    txHash: row.txHash as `0x${string}`,
    at: row.at ?? new Date(0),
  };
}

const POSITION_EVENTS = ['PositionChanged', 'PositionSettled', 'Liquidated', 'ForcedExitRequested', 'ForcedExitSettled'];
const OFFER_EVENTS = ['OfferPosted', 'OfferFilled', 'OfferWithdrawn'];

/**
 * After a rewind to `ancestor` (rows above it already deleted): rebuild the positions, offers and pool
 * reserves that events above the ancestor had touched, by refolding the ChainEvent rows that remain.
 */
export async function rebuildState(tx: Tx, ctx: ProjectionContext, ancestor: bigint, names: Map<LowerAddress, string>): Promise<{ positions: number; offers: number; pools: number }> {
  const chainId = ctx.chainId;
  const above = { chainId, lastBlock: { gt: ancestor } };
  const [positions, offers, pools] = await Promise.all([
    tx.perpPosition.findMany({ where: above, select: { perps: true, positionId: true } }),
    tx.makerOffer.findMany({ where: above, select: { book: true, offerId: true } }),
    tx.spotPoolState.findMany({ where: above, select: { pools: true, stock: true } }),
  ]);
  await tx.perpPosition.deleteMany({ where: above });
  await tx.makerOffer.deleteMany({ where: above });
  await tx.spotPoolState.deleteMany({ where: above });

  const rows: Array<Parameters<typeof eventFromRow>[0]> = [];
  const select = { kind: true, address: true, txHash: true, logIndex: true, block: true, at: true, data: true } as const;
  if (positions.length) {
    const ids = positions.map((p) => p.positionId.toString());
    const perps = [...new Set(positions.map((p) => p.perps))];
    const found = await tx.chainEvent.findMany({ where: { chainId, address: { in: perps }, kind: { in: POSITION_EVENTS } }, select });
    const mine = found.filter((r) => ids.includes(String((r.data as JsonArgs).id)));
    rows.push(...mine);
    // The offer fills of the opens (same transaction), for the position's size and offer id.
    const txs = [...new Set(mine.filter((r) => r.kind === 'PositionChanged').map((r) => r.txHash))];
    if (txs.length) rows.push(...(await tx.chainEvent.findMany({ where: { chainId, kind: 'OfferFilled', txHash: { in: txs } }, select })));
  }
  if (offers.length) {
    const ids = offers.map((o) => o.offerId.toString());
    const books = [...new Set(offers.map((o) => o.book))];
    const found = await tx.chainEvent.findMany({ where: { chainId, address: { in: books }, kind: { in: OFFER_EVENTS } }, select });
    for (const r of found) if (ids.includes(String((r.data as JsonArgs).id)) && !rows.some((x) => x.txHash === r.txHash && x.logIndex === r.logIndex)) rows.push(r);
  }
  if (pools.length) {
    const stocks = pools.map((p) => p.stock);
    const addrs = [...new Set(pools.map((p) => p.pools))];
    const found = await tx.chainEvent.findMany({ where: { chainId, address: { in: addrs }, kind: 'PoolChanged', market: { in: stocks } }, select });
    rows.push(...found);
  }
  rows.sort((x, y) => (x.block === y.block ? x.logIndex - y.logIndex : x.block < y.block ? -1 : 1));
  await applyEvents(tx, ctx, rows.map((r) => eventFromRow(r, names)), false);
  return { positions: positions.length, offers: offers.length, pools: pools.length };
}
