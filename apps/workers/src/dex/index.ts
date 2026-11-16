import { dexPoolsOf, type NetworkName } from '@velum/config';
import type { CacheMac } from '@velum/config/src/cache-mac';
import type { PrismaClient } from '@velum/db';
import type { Redis } from 'ioredis';
import type { Logger } from '../lib/log';
import { redact } from '../lib/redact';
import { DEFAULT_DEX_SETTINGS, runDex, verifyPools, type DexContext, type DexSettings } from './indexer';
import { viemDexRpc, type DexRpc } from './rpc';

export interface DexStartOptions {
  network: NetworkName;
  rpcUrl: string;
  chainId: number;
  pollMs: number;
  backfillHours: number;
  retentionDays: number;
  prisma: PrismaClient;
  redis: Redis;
  mac: CacheMac;
  log: Logger;
  /** The last official quote of a market (token basis), read from the price snapshots: only to bound DEX trades. */
  quote(symbol: string): string | null;
  rpc?: DexRpc;
  signal?: AbortSignal;
}

/** Seconds per block on Robinhood Chain mainnet, measured 2026-11-15 over 100,000 blocks. */
const SECONDS_PER_BLOCK = 0.1078;

/**
 * Starts the display-only DEX indexer (mainnet with configured pools): checks the pools' tokens, then runs every
 * `pollMs` (one run at a time). Returns a stop function, or null when there is nothing to index.
 */
export async function startDex(o: DexStartOptions): Promise<(() => void) | null> {
  const configured = Object.values(dexPoolsOf(o.network));
  if (!configured.length) return null;
  const rpc = o.rpc ?? viemDexRpc(o.rpcUrl);
  const pools = await verifyPools(rpc, configured, o.log);
  if (!pools.length) {
    o.log.warn('DEX indexer off: no configured pool could be checked');
    return null;
  }
  const settings: DexSettings = {
    ...DEFAULT_DEX_SETTINGS,
    backfillBlocks: BigInt(Math.round((o.backfillHours * 3600) / SECONDS_PER_BLOCK)),
    retentionMs: o.retentionDays * 86_400_000,
  };
  const ctx: DexContext = { prisma: o.prisma, redis: o.redis, mac: o.mac, log: o.log, rpc, chainId: o.chainId, pools, quote: o.quote, settings, liquidity: new Map() };
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const loop = async () => {
    if (stopped) return;
    try {
      const r = await runDex(ctx);
      if (r.trades) o.log.debug('DEX trades indexed', { trades: r.trades, to: r.to?.toString() });
    } catch (err) {
      o.log.warn('DEX indexer run failed; retried on the next run', { err: redact(err instanceof Error ? err.message : String(err)) });
    }
    if (!stopped) timer = setTimeout(() => void loop(), o.pollMs);
  };
  o.signal?.addEventListener('abort', () => (stopped = true));
  void loop();
  o.log.info('DEX indexer started (display only)', { pools: pools.length, pollMs: o.pollMs });
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
