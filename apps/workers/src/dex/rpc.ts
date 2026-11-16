import { createPublicClient, http, type PublicClient } from 'viem';

export interface DexBlock {
  number: bigint;
  hash: string;
  /** Unix seconds. */
  timestamp: number;
}

export interface DexLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: string;
  removed?: boolean;
}

/** The read-only RPC calls the DEX indexer makes (never a transaction). A fake implements it in tests. */
export interface DexRpc {
  /** The newest confirmed block: the `safe` tag (posted to the parent chain), else latest minus `fallbackDepth`. */
  confirmedHead(fallbackDepth: bigint): Promise<DexBlock>;
  block(n: bigint): Promise<DexBlock>;
  /** Logs of `addresses` with topic0 = `topic0` in [from, to]. */
  logs(addresses: readonly string[], topic0: string, from: bigint, to: bigint): Promise<DexLog[]>;
  /** eth_call at the latest block. */
  call(to: string, data: string): Promise<string>;
}

const toBlock = (b: { number: bigint | null; hash: string | null; timestamp: bigint }): DexBlock => {
  if (b.number === null || b.hash === null) throw new Error('pending block');
  return { number: b.number, hash: b.hash, timestamp: Number(b.timestamp) };
};

/** DexRpc over viem's HTTP transport (RPC_URL), one request at a time with a pause between, so the public endpoint is never loaded. */
export function viemDexRpc(rpcUrl: string, pauseMs = 120): DexRpc {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000, retryCount: 2, retryDelay: 1000 }) }) as PublicClient;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn).finally(() => new Promise((r) => setTimeout(r, pauseMs)));
    tail = run.catch(() => undefined);
    return run;
  };
  return {
    confirmedHead: (fallbackDepth) =>
      serial(async () => {
        try {
          return toBlock(await client.getBlock({ blockTag: 'safe' }));
        } catch {
          const latest = await client.getBlockNumber({ cacheTime: 0 });
          return toBlock(await client.getBlock({ blockNumber: latest > fallbackDepth ? latest - fallbackDepth : 0n }));
        }
      }),
    block: (n) => serial(async () => toBlock(await client.getBlock({ blockNumber: n }))),
    logs: (addresses, topic0, from, to) =>
      serial(async () => {
        const raw = (await client.request({
          method: 'eth_getLogs',
          params: [{ address: addresses as `0x${string}`[], topics: [topic0 as `0x${string}`], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
        })) as Array<{ address: string; topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash: string; removed?: boolean }>;
        return raw.map((l) => ({
          address: l.address.toLowerCase(),
          topics: l.topics,
          data: l.data,
          blockNumber: BigInt(l.blockNumber),
          logIndex: Number(BigInt(l.logIndex)),
          transactionHash: l.transactionHash.toLowerCase(),
          removed: l.removed,
        }));
      }),
    call: (to, data) => serial(async () => (await client.call({ to: to as `0x${string}`, data: data as `0x${string}` })).data ?? '0x'),
  };
}
