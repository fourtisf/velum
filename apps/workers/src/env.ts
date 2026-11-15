import { CHAIN, NETWORK, parseRedisUrl, type NetworkName, type PriceSource, type RedisConnection } from '@velum/config';
import { redactUrls } from './lib/redact';

export interface WorkerEnv {
  databaseUrl: string;
  redisUrl: string;
  /** ioredis options parsed from REDIS_URL (TCP or unix socket, audit M-2). */
  redis: RedisConnection;
  demoMode: boolean;
  pricePollMs: number;
  priceSource: PriceSource;
  rpcUrl: string;
  chainId: number;
  tickRetentionDays: number;
  network: NetworkName;
}

/** Log levels LOG_LEVEL accepts (pino's names, shared with the API; fatal/trace map to error/debug). */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const bool = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());

/** Read and validate the environment. Throws one error listing every problem. */
export function loadEnv(e: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const problems: string[] = [];
  const int = (name: string, raw: string | undefined, dflt: number, min: number, max: number): number => {
    if (raw === undefined || raw === '') return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${min} and ${max} (got "${raw}").`);
      return dflt;
    }
    return n;
  };

  const databaseUrl = e.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push('DATABASE_URL must be a postgresql:// URL.');
  const redisUrl = e.REDIS_URL ?? '';
  const redis = parseRedisUrl(redisUrl);
  if (!redis.ok) problems.push(redis.error);

  const rpcUrl = e.RPC_URL && !e.RPC_URL.startsWith('VERIFY') ? e.RPC_URL : CHAIN.rpcUrl;
  if (!/^https?:\/\//.test(rpcUrl)) problems.push('RPC_URL must be an http(s) URL.');

  const otherNet = NETWORK === 'mainnet' ? 'rpc.testnet.chain.robinhood.com' : 'rpc.mainnet.chain.robinhood.com';
  if (rpcUrl.includes(otherNet)) problems.push(`RPC_URL points at the other network (${redactUrls(rpcUrl)}) but VELUM_NETWORK=${NETWORK}.`);
  const chainId = int('CHAIN_ID', e.CHAIN_ID, CHAIN.id, 1, Number.MAX_SAFE_INTEGER);
  if (chainId !== CHAIN.id) {
    problems.push(`CHAIN_ID ${chainId} does not match VELUM_NETWORK=${NETWORK} (${CHAIN.label}, chain ${CHAIN.id}). Set VELUM_NETWORK and CHAIN_ID together (deploy/set-network.sh does both).`);
  }
  // The network this environment asks for (the same as NETWORK in production, where e is process.env).
  const network: NetworkName = (e.VELUM_NETWORK ?? '').trim().toLowerCase() === 'mainnet' ? 'mainnet' : NETWORK;

  const src = (e.PRICE_SOURCE || 'demo').trim().toLowerCase();
  if (src !== 'demo' && src !== 'chainlink' && src !== 'robinhood') problems.push(`PRICE_SOURCE must be "demo", "robinhood" or "chainlink" (got "${e.PRICE_SOURCE}").`);
  // Mainnet shows live prices only (web audit F2): simulated prices must never run under VELUM_NETWORK=mainnet.
  if (network === 'mainnet' && src === 'demo') {
    problems.push('PRICE_SOURCE=demo (the default) is not allowed with VELUM_NETWORK=mainnet: mainnet shows live prices only. Set PRICE_SOURCE=robinhood (deploy/set-network.sh mainnet does).');
  }

  const logLevel = (e.LOG_LEVEL ?? '').trim();
  if (logLevel && !(LOG_LEVELS as readonly string[]).includes(logLevel)) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got "${e.LOG_LEVEL}").`);

  const env: WorkerEnv = {
    databaseUrl,
    redisUrl,
    redis: redis.ok ? redis.options : { db: 0 },
    demoMode: bool(e.DEMO_MODE, true),
    pricePollMs: int('PRICE_POLL_MS', e.PRICE_POLL_MS, 2000, 500, 60_000),
    priceSource: src === 'chainlink' || src === 'robinhood' ? src : 'demo',
    rpcUrl,
    chainId,
    tickRetentionDays: int('PRICE_TICK_RETENTION_DAYS', e.PRICE_TICK_RETENTION_DAYS, 7, 1, 365),
    network,
  };
  if (problems.length) throw new Error(`Invalid workers environment:\n  - ${problems.join('\n  - ')}`);
  return env;
}
