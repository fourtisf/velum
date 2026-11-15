/**
 * Phase 3 reads: the deployment file of the configured chain and the indexer's tables (written by
 * apps/workers/src/onchain). Amounts are stored as integers in base units; the views here format them as
 * exact decimal strings (USDG and tokens in whole units, prices in USDG per token). Addresses are stored
 * lower case and returned checksummed.
 */
import { readDeploymentFile } from '@velum/config/src/deployment-file';
import type { Deployment } from '@velum/config/src/onchain';
import { Prisma, type PrismaClient } from '@velum/db';
import { getAddress } from 'viem';

/** The deployment file, re-read when it changes (checked at most every `checkMs`). */
export interface DeploymentSource {
  get(): Deployment | null;
}

export function deploymentSource(dir: string, chainId: number, checkMs = 5000, now: () => number = Date.now): DeploymentSource {
  let cached: { at: number; value: Deployment | null } | null = null;
  return {
    get() {
      if (cached && now() - cached.at < checkMs) return cached.value;
      const read = readDeploymentFile(dir, chainId);
      cached = { at: now(), value: read.status === 'ok' ? read.deployment : null };
      return cached.value;
    },
  };
}

/** A fixed deployment (tests). */
export const staticDeployment = (d: Deployment | null): DeploymentSource => ({ get: () => d });

export const checksum = (a: string | null | undefined): string | null => (a ? getAddress(a) : null);

/** An integer in base units as an exact decimal string. */
export function fmtUnits(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const s = frac ? `${a / base}.${frac}` : `${a / base}`;
  return neg && a !== 0n ? `-${s}` : s;
}

const int = (d: { toFixed(): string } | null | undefined): bigint | null => (d === null || d === undefined ? null : BigInt(d.toFixed()));

export type PositionStatusFilter = 'open' | 'closed' | 'all';

export interface PositionView {
  id: string;
  market: string | null;
  token: string;
  /** The queried account's role. */
  role: 'taker' | 'maker';
  /** The taker's side. */
  side: 'long' | 'short';
  taker: string;
  maker: string;
  status: 'open' | 'closed' | 'liquidated' | 'forced_exit';
  /** Tokens. */
  qty: string;
  /** USDG per token. */
  entry: string;
  /** USDG notional at open (the maker offer's fill size), null when unknown. */
  size: string | null;
  takerMargin: string;
  makerMargin: string;
  offerId: string | null;
  openedAt: number;
  openBlock: number;
  openTx: string;
  closedAt: number | null;
  closeBlock: number | null;
  closeTx: string | null;
  closePrice: string | null;
  exitPrice: string | null;
  takerPnl: string | null;
  takerFunding: string | null;
  fee: string | null;
  takerOut: string | null;
  makerOut: string | null;
  liquidation: { liquidator: string; side: string; price: string | null; penalty: string | null; reward: string | null; shortfall: string | null } | null;
  forcedExit: { requester: string; requestedAt: number | null; settleAfter: number | null; atEntry: boolean | null } | null;
}

export interface ActivityItem {
  kind: string;
  tx: string;
  block: number;
  logIndex: number;
  at: number;
  contract: string;
  market: string | null;
  token: string | null;
  positionId: string | null;
  data: Record<string, unknown>;
}

export interface ActivityPage {
  items: ActivityItem[];
  /** Pass as `before` for the next (older) page; null on the last page. */
  next: string | null;
}

export interface FundingPointView {
  t: number;
  /** Percent per hour (0.0042 = 0.0042%/h), signed: positive means longs pay shorts. */
  rate: string;
  /** Cumulative funding per token, USDG. */
  index: string;
  block: number;
  tx: string;
}

export interface OnchainReader {
  positions(d: Deployment, account: string, status: PositionStatusFilter, limit: number): Promise<PositionView[]>;
  activity(d: Deployment, account: string, limit: number, before: { block: bigint; logIndex: number } | null): Promise<ActivityPage>;
  funding(d: Deployment, market: string, limit: number): Promise<FundingPointView[]>;
  /** Latest close-only flag per market (from CloseOnlySet events), lower-case token -> flag. */
  closeOnly(d: Deployment): Promise<Record<string, boolean>>;
}

/** `${block}-${logIndex}` cursor of an activity row. */
export const activityCursor = (block: bigint, logIndex: number): string => `${block}-${logIndex}`;

/** The columns the cursor is compared with: block BIGINT, logIndex INTEGER. */
const MAX_BLOCK = 2n ** 63n - 1n;
const MAX_LOG_INDEX = 2 ** 31 - 1;

/**
 * A `before` cursor, null when absent, 'invalid' (a 400) when malformed or out of the columns' range: a block above
 * BIGINT or a log index above INTEGER would otherwise fail in Postgres and answer 503 (on-chain workers audit L-9).
 */
export function parseActivityCursor(raw: string | undefined): { block: bigint; logIndex: number } | null | 'invalid' {
  if (raw === undefined || raw === '') return null;
  const m = /^(\d{1,19})-(\d{1,10})$/.exec(raw);
  if (!m) return 'invalid';
  const block = BigInt(m[1]!);
  const logIndex = Number(m[2]);
  return block <= MAX_BLOCK && logIndex <= MAX_LOG_INDEX ? { block, logIndex } : 'invalid';
}

type PositionRow = Prisma.PerpPositionGetPayload<Record<string, never>>;

export function positionView(r: PositionRow, account: string, usdgDecimals: number): PositionView {
  const usdg = (d: { toFixed(): string } | null) => {
    const v = int(d);
    return v === null ? null : fmtUnits(v, usdgDecimals);
  };
  const wad = (d: { toFixed(): string } | null) => {
    const v = int(d);
    return v === null ? null : fmtUnits(v, 18);
  };
  return {
    id: r.positionId.toString(),
    market: r.symbol,
    token: getAddress(r.market),
    role: r.taker === account ? 'taker' : 'maker',
    side: r.isLong ? 'long' : 'short',
    taker: getAddress(r.taker),
    maker: getAddress(r.maker),
    status: r.status,
    qty: wad(r.qty)!,
    entry: wad(r.entry)!,
    size: usdg(r.size),
    takerMargin: usdg(r.takerMargin)!,
    makerMargin: usdg(r.makerMargin)!,
    offerId: r.offerId === null ? null : r.offerId.toString(),
    openedAt: r.openedAt.getTime(),
    openBlock: Number(r.openedBlock),
    openTx: r.openTx,
    closedAt: r.closedAt ? r.closedAt.getTime() : null,
    closeBlock: r.closedBlock === null ? null : Number(r.closedBlock),
    closeTx: r.closeTx,
    closePrice: wad(r.closePrice),
    exitPrice: wad(r.exitPrice),
    takerPnl: usdg(r.takerPnl),
    takerFunding: usdg(r.takerFunding),
    fee: usdg(r.fee),
    takerOut: usdg(r.takerOut),
    makerOut: usdg(r.makerOut),
    liquidation: r.liquidator
      ? { liquidator: getAddress(r.liquidator), side: r.liquidatedSide ?? 'taker', price: wad(r.liquidationPrice), penalty: usdg(r.penalty), reward: usdg(r.reward), shortfall: usdg(r.shortfall) }
      : null,
    forcedExit: r.exitRequester
      ? { requester: getAddress(r.exitRequester), requestedAt: r.exitRequestedAt?.getTime() ?? null, settleAfter: r.exitSettleAfter?.getTime() ?? null, atEntry: r.exitAtEntry }
      : null,
  };
}

/** Addresses in an activity row's data are returned checksummed, like everywhere else. */
function checksumData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return Object.fromEntries(Object.entries(data as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v) ? getAddress(v) : v]));
}

export function prismaOnchain(prisma: PrismaClient): OnchainReader {
  const usdgDecimals = async (d: Deployment): Promise<number> => {
    const t = await prisma.onchainToken.findUnique({ where: { chainId_address: { chainId: d.chainId, address: d.tokens.USDG! } }, select: { decimals: true } });
    return t?.decimals ?? 6;
  };
  return {
    async positions(d, account, status, limit) {
      const base: Prisma.PerpPositionWhereInput = { chainId: d.chainId, perps: d.contracts.perpsMarkets, OR: [{ taker: account }, { maker: account }] };
      const orderBy: Prisma.PerpPositionOrderByWithRelationInput[] = [{ openedBlock: 'desc' }, { positionId: 'desc' }];
      const open = () => prisma.perpPosition.findMany({ where: { ...base, status: 'open' }, orderBy, take: limit });
      const closed = (take: number) => prisma.perpPosition.findMany({ where: { ...base, status: { not: 'open' } }, orderBy, take });
      const dec = usdgDecimals(d);
      // Open positions first, selected as such (audit L-9: the newest `limit` rows sorted afterwards could leave an
      // old open position out), then the newest closed ones up to the limit.
      let rows: Awaited<ReturnType<typeof open>>;
      if (status === 'open') rows = await open();
      else if (status === 'closed') rows = await closed(limit);
      else {
        const o = await open();
        rows = o.length < limit ? [...o, ...(await closed(limit - o.length))] : o;
      }
      const decimals = await dec;
      return rows.map((r) => positionView(r, account, decimals));
    },
    async activity(d, account, limit, before) {
      const contracts = Object.values(d.contracts);
      const rows = await prisma.accountActivity.findMany({
        where: {
          chainId: d.chainId,
          account,
          contract: { in: contracts },
          ...(before ? { OR: [{ block: { lt: before.block } }, { block: before.block, logIndex: { lt: before.logIndex } }] } : {}),
        },
        orderBy: [{ block: 'desc' }, { logIndex: 'desc' }],
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => ({
          kind: r.kind,
          tx: r.txHash,
          block: Number(r.block),
          logIndex: r.logIndex,
          at: r.at.getTime(),
          contract: getAddress(r.contract),
          market: r.symbol,
          token: checksum(r.market),
          positionId: r.positionId === null ? null : r.positionId.toString(),
          data: checksumData(r.data),
        })),
        next: rows.length > limit && last ? activityCursor(last.block, last.logIndex) : null,
      };
    },
    async funding(d, market, limit) {
      const rows = await prisma.fundingPoint.findMany({
        where: { chainId: d.chainId, perps: d.contracts.perpsMarkets, market },
        orderBy: [{ block: 'desc' }, { logIndex: 'desc' }],
        take: limit,
      });
      return rows.reverse().map((r) => ({
        t: r.timestamp.getTime(),
        rate: fmtUnits(BigInt(r.rate.toFixed()), 16),
        index: fmtUnits(BigInt(r.index.toFixed()), 18),
        block: Number(r.block),
        tx: r.txHash,
      }));
    },
    async closeOnly(d) {
      // The latest CloseOnlySet per market, selected in SQL (audit L-9: an oldest-first read capped at 1,000 events
      // stopped seeing newer flags once the history grew past the cap).
      const rows = await prisma.$queryRaw<Array<{ data: unknown }>>(Prisma.sql`
        SELECT DISTINCT ON (COALESCE("market", "data"->>'market')) "data" FROM "ChainEvent"
        WHERE "chainId" = ${d.chainId} AND "address" = ${d.contracts.perpsMarkets} AND "kind" = 'CloseOnlySet'
        ORDER BY COALESCE("market", "data"->>'market'), "block" DESC, "logIndex" DESC
        LIMIT 256`);
      const out: Record<string, boolean> = {};
      for (const sym of Object.keys(d.tokens)) if (sym !== 'USDG') out[d.tokens[sym]!] = false;
      for (const r of rows) {
        const v = (r.data ?? {}) as { market?: unknown; closeOnly?: unknown };
        if (typeof v.market === 'string') out[v.market] = v.closeOnly === true;
      }
      return out;
    },
  };
}
