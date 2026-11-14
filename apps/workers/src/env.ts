import { CHAIN, NETWORK, type PriceSource } from '@velum/config';
import { redactUrls } from './lib/redact';

export interface WorkerEnv {
  databaseUrl: string;
  redisUrl: string;
  demoMode: boolean;
  pricePollMs: number;
  priceSource: PriceSource;
  rpcUrl: string;
  chainId: number;
  tickRetentionDays: number;
}

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
  if (!/^rediss?:\/\//.test(redisUrl)) problems.push('REDIS_URL must be a redis:// URL.');

  const rpcUrl = e.RPC_URL && !e.RPC_URL.startsWith('VERIFY') ? e.RPC_URL : CHAIN.rpcUrl;
  if (!/^https?:\/\//.test(rpcUrl)) problems.push('RPC_URL must be an http(s) URL.');

  const otherNet = NETWORK === 'mainnet' ? 'rpc.testnet.chain.robinhood.com' : 'rpc.mainnet.chain.robinhood.com';
  if (rpcUrl.includes(otherNet)) problems.push(`RPC_URL points at the other network (${redactUrls(rpcUrl)}) but VELUM_NETWORK=${NETWORK}.`);
  const chainId = int('CHAIN_ID', e.CHAIN_ID, CHAIN.id, 1, Number.MAX_SAFE_INTEGER);
  if (chainId !== CHAIN.id) {
    problems.push(`CHAIN_ID ${chainId} does not match VELUM_NETWORK=${NETWORK} (${CHAIN.label}, chain ${CHAIN.id}). Set VELUM_NETWORK and CHAIN_ID together (deploy/set-network.sh does both).`);
  }

  const src = (e.PRICE_SOURCE || 'demo').trim().toLowerCase();
  if (src !== 'demo' && src !== 'chainlink' && src !== 'robinhood') problems.push(`PRICE_SOURCE must be "demo", "robinhood" or "chainlink" (got "${e.PRICE_SOURCE}").`);

  const env: WorkerEnv = {
    databaseUrl,
    redisUrl,
    demoMode: bool(e.DEMO_MODE, true),
    pricePollMs: int('PRICE_POLL_MS', e.PRICE_POLL_MS, 2000, 500, 60_000),
    priceSource: src === 'chainlink' || src === 'robinhood' ? src : 'demo',
    rpcUrl,
    chainId,
    tickRetentionDays: int('PRICE_TICK_RETENTION_DAYS', e.PRICE_TICK_RETENTION_DAYS, 7, 1, 365),
  };
  if (problems.length) throw new Error(`Invalid workers environment:\n  - ${problems.join('\n  - ')}`);
  return env;
}
