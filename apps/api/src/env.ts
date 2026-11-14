import { CHAIN, NETWORK } from '@velum/config';
import { redactUrls } from './lib/redact';

export interface ApiEnv {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  corsOrigins: string[] | true | false;
  rateReadPerMin: number;
  rateQuotePerMin: number;
  rateHealthPerMin: number;
  rpcUrl: string;
  chainId: number;
  demoMode: boolean;
  logLevel: string;
}

const bool = (v: string | undefined, dflt: boolean): boolean => {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
};

/** Read and validate the environment. Throws one error listing every problem. */
export function loadEnv(e: NodeJS.ProcessEnv = process.env): ApiEnv {
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

  const rawCors = (e.CORS_ORIGIN ?? '').trim();
  let corsOrigins: ApiEnv['corsOrigins'] = false;
  if (rawCors === '*') corsOrigins = true;
  else if (rawCors) {
    corsOrigins = rawCors.split(',').map((s) => s.trim()).filter(Boolean);
    for (const o of corsOrigins) if (!/^https?:\/\/[^/]+$/.test(o)) problems.push(`CORS_ORIGIN entry "${o}" must be an origin like https://velum.example (no path).`);
  }

  const env: ApiEnv = {
    host: e.HOST || '127.0.0.1',
    port: int('PORT_API', e.PORT_API ?? e.PORT, 4000, 1, 65535),
    databaseUrl,
    redisUrl,
    corsOrigins,
    rateReadPerMin: int('RATE_LIMIT_READ_PER_MIN', e.RATE_LIMIT_READ_PER_MIN, 120, 1, 100_000),
    rateQuotePerMin: int('RATE_LIMIT_QUOTE_PER_MIN', e.RATE_LIMIT_QUOTE_PER_MIN, 30, 1, 100_000),
    rateHealthPerMin: int('RATE_LIMIT_HEALTH_PER_MIN', e.RATE_LIMIT_HEALTH_PER_MIN, 60, 1, 100_000),
    rpcUrl,
    chainId,
    demoMode: bool(e.DEMO_MODE, true),
    logLevel: e.LOG_LEVEL || (e.NODE_ENV === 'production' ? 'info' : 'debug'),
  };

  if (problems.length) throw new Error(`Invalid API environment:\n  - ${problems.join('\n  - ')}`);
  return env;
}
