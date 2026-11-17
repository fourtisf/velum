'use client';
/**
 * A wallet's recent trades and transfers on Robinhood Chain mainnet, read straight from the chain: the ERC-20 Transfer
 * events of USDG, every Stock Token and WETH into and out of the wallet (one single-address query per token and direction,
 * which the public RPC answers over up to 10,000,000 blocks: about 12 days at its ~0.11 s blocks). Grouped per
 * transaction into what happened: bought (with USDG or with ETH), sold, swapped, sent, received. Nothing is stored by
 * Velum; trades made anywhere (another device, another app) show up the same.
 */
import { TOKENS } from '@velum/config';
import { UNISWAP } from '@velum/config/src/uniswap';
import { useQuery } from '@tanstack/react-query';
import { pad, type Address, type Hex } from 'viem';
import { WETH_TOKEN } from './balances';
import { publicClient } from './chain';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** The tokens whose transfers make up the activity: USDG, the Stock Tokens and, on mainnet, WETH. */
export const ACTIVITY_TOKENS: Record<string, { address: string; decimals: number }> = { ...TOKENS, ...(WETH_TOKEN ? { WETH: WETH_TOKEN } : {}) };
/** How far back activity is read, in blocks (under the RPC's 10,000,000-block limit for a single-address query). */
export const ACTIVITY_BLOCKS = 9_900_000n;
/** At most this many transactions are shown (each needs its block time). */
export const ACTIVITY_MAX = 15;
/** At most this many transactions are read for the cost basis (lib/costBasis.ts). */
export const ACTIVITY_SCAN_MAX = 200;
/** Parallel requests to the public RPC (it answers HTTP 429 to bursts). */
const RPC_PARALLEL = 4;

export interface Move {
  sym: string;
  /** Base units of the token. */
  units: bigint;
  decimals: number;
}

export type ActKind = 'buy' | 'sell' | 'swap' | 'send' | 'receive';

export interface WalletAct {
  hash: Hex;
  block: bigint;
  kind: ActKind;
  /** What left the wallet and what arrived (net per token in this transaction). */
  out: Move[];
  in: Move[];
  /** ETH sent with the transaction (a buy with ETH), wei. */
  ethPaid: bigint;
  /** A buy with ETH: the USDG (base units) the ETH became inside the swap, from the receipt; its cost in dollars. */
  usdCost: bigint | null;
  /** The other side of a plain transfer. */
  counterparty: Address | null;
  /** Block time, ms. */
  time: number | null;
}

interface RawLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
}

const lower = (a: string) => a.toLowerCase();
const topicAddr = (t: Hex) => `0x${t.slice(26)}`.toLowerCase() as Address;

/** Groups transfer logs of the wallet into transactions, newest first (pure: unit-tested). */
export function groupMoves(me: Address, logs: RawLog[], tokens: Record<string, { address: string; decimals: number }>): Array<Omit<WalletAct, 'ethPaid' | 'usdCost' | 'time' | 'kind'> & { kind: ActKind | null }> {
  const bySym = new Map(Object.entries(tokens).map(([sym, t]) => [lower(t.address), { sym, decimals: t.decimals }]));
  const self = lower(me);
  const seen = new Set<string>();
  const txs = new Map<Hex, { block: bigint; net: Map<string, bigint>; other: Address | null }>();
  for (const l of logs) {
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(key) || l.topics[0] !== TRANSFER || l.topics.length < 3) continue;
    seen.add(key);
    const tok = bySym.get(lower(l.address));
    if (!tok) continue;
    const from = topicAddr(l.topics[1]!);
    const to = topicAddr(l.topics[2]!);
    const value = BigInt(l.data === '0x' ? 0 : l.data);
    const tx = txs.get(l.transactionHash) ?? { block: BigInt(l.blockNumber), net: new Map(), other: null };
    if (from === self && to !== self) {
      tx.net.set(tok.sym, (tx.net.get(tok.sym) ?? 0n) - value);
      tx.other = to;
    } else if (to === self && from !== self) {
      tx.net.set(tok.sym, (tx.net.get(tok.sym) ?? 0n) + value);
      tx.other = from;
    }
    txs.set(l.transactionHash, tx);
  }
  const out: Array<Omit<WalletAct, 'ethPaid' | 'usdCost' | 'time' | 'kind'> & { kind: ActKind | null }> = [];
  for (const [hash, tx] of txs) {
    const ins: Move[] = [];
    const outs: Move[] = [];
    for (const [sym, n] of tx.net) {
      const decimals = tokens[sym]!.decimals;
      if (n > 0n) ins.push({ sym, units: n, decimals });
      else if (n < 0n) outs.push({ sym, units: -n, decimals });
    }
    if (!ins.length && !outs.length) continue;
    const insStock = ins.filter((m) => m.sym !== 'USDG');
    const outsStock = outs.filter((m) => m.sym !== 'USDG');
    let kind: ActKind | null;
    if (ins.length && outs.length) kind = insStock.length && outsStock.length ? 'swap' : insStock.length ? 'buy' : 'sell';
    else if (outs.length) kind = 'send';
    else kind = null; // only arrivals: a receive, or a buy paid with ETH (decided from the transaction)
    out.push({ hash, block: tx.block, kind, out: outs, in: ins, counterparty: ins.length && outs.length ? null : tx.other });
  }
  return out.sort((a, b) => (b.block > a.block ? 1 : b.block < a.block ? -1 : 0));
}

/** Runs `fn` over `items` with at most `n` at a time, keeping the order. */
async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** The USDG that left the ETH leg pool in a receipt: what the ETH of a buy-with-ETH became (base units). */
export function usdgFromEthLeg(logs: ReadonlyArray<{ address: string; topics: readonly Hex[]; data: Hex }>, usdg: string, ethLeg: string): bigint | null {
  let sum = 0n;
  let seen = false;
  for (const l of logs) {
    if (lower(l.address) !== lower(usdg) || l.topics[0] !== TRANSFER || l.topics.length < 3) continue;
    if (topicAddr(l.topics[1]!) !== lower(ethLeg)) continue;
    sum += BigInt(l.data === '0x' ? 0 : l.data);
    seen = true;
  }
  return seen ? sum : null;
}

/**
 * Reads the wallet's recent activity (see the file comment): every transaction in the window, newest first (at most
 * ACTIVITY_SCAN_MAX), with block times for the newest ACTIVITY_MAX (the ones shown).
 */
export async function readWalletActivity(me: Address): Promise<WalletAct[]> {
  const head = await publicClient.getBlockNumber();
  const fromBlock: Hex = `0x${(head > ACTIVITY_BLOCKS ? head - ACTIVITY_BLOCKS : 0n).toString(16)}`;
  const toBlock: Hex = `0x${head.toString(16)}`;
  const mine = pad(me);
  const queries = Object.values(ACTIVITY_TOKENS).flatMap((t) => [
    { address: lower(t.address) as Hex, topics: [TRANSFER, mine] as Array<Hex | null> },
    { address: lower(t.address) as Hex, topics: [TRANSFER, null, mine] as Array<Hex | null> },
  ]);
  const logs = (
    await mapLimit(queries, RPC_PARALLEL, (q) =>
      publicClient.request({ method: 'eth_getLogs', params: [{ ...q, fromBlock, toBlock } as { address: Hex; topics: Array<Hex | null>; fromBlock: Hex; toBlock: Hex }] }),
    )
  ).flat() as RawLog[];
  const grouped = groupMoves(me, logs, ACTIVITY_TOKENS).slice(0, ACTIVITY_SCAN_MAX);
  const router = UNISWAP ? lower(UNISWAP.contracts.universalRouter) : null;
  const blocks = new Map<bigint, number | null>();
  await mapLimit([...new Set(grouped.slice(0, ACTIVITY_MAX).map((g) => g.block))], RPC_PARALLEL, async (n) => {
    try {
      blocks.set(n, Number((await publicClient.getBlock({ blockNumber: n })).timestamp) * 1000);
    } catch {
      blocks.set(n, null);
    }
  });
  return mapLimit(grouped, RPC_PARALLEL, async (g): Promise<WalletAct> => {
    let kind = g.kind;
    let ethPaid = 0n;
    let usdCost: bigint | null = null;
    if (kind === null) {
      // Only arrivals: a buy paid with ETH when the wallet sent ETH to the Uniswap router in this transaction; its cost
      // is the USDG the ETH became in the swap (the receipt's transfer out of the ETH leg pool).
      try {
        const tx = await publicClient.getTransaction({ hash: g.hash });
        if (tx.value > 0n && router && tx.to && lower(tx.to) === router && lower(tx.from) === lower(me)) {
          kind = 'buy';
          ethPaid = tx.value;
          if (UNISWAP) {
            const rc = await publicClient.getTransactionReceipt({ hash: g.hash });
            usdCost = usdgFromEthLeg(rc.logs, UNISWAP.usdg.address, UNISWAP.ethLeg.address);
          }
        }
      } catch {
        /* unknown: shown as received */
      }
      kind ??= 'receive';
    }
    return { ...g, kind, ethPaid, usdCost, counterparty: kind === 'buy' ? null : g.counterparty, time: blocks.get(g.block) ?? null };
  });
}

export function useWalletActivity(me: Address | undefined) {
  return useQuery({
    queryKey: ['public-activity', me],
    queryFn: () => readWalletActivity(me!),
    enabled: !!me,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}
