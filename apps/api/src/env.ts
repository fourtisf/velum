import { CHAIN, NETWORK, parseRedisUrl, type NetworkName, type RedisConnection } from '@velum/config';
import { defaultDeploymentsDir } from '@velum/config/src/deployment-file';
import { redactUrls } from './lib/redact';

/** Log levels LOG_LEVEL accepts (pino's, audit I-5). */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export interface ApiEnv {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** ioredis options parsed from REDIS_URL: TCP, or the unix socket of deploy/redis-velum.sh (audit M-2). */
  redis: RedisConnection;
  corsOrigins: string[] | true | false;
  rateReadPerMin: number;
  rateQuotePerMin: number;
  rateHealthPerMin: number;
  /**
   * Per-client budget for GET /v1/markets and /v1/markets/:symbol (audit L-5), separate from the read
   * budget: the web polls every 2 s, so one browser tab uses 30 a minute and several users behind one
   * NAT address would starve each other at 120. These answers come from a 1 s in-process cache.
   */
  rateMarketsPerMin: number;
  rpcUrl: string;
  chainId: number;
  /** testnet or mainnet (VELUM_NETWORK). Mainnet returns null for numbers that have no real source yet. */
  network: NetworkName;
  /**
   * Always true in Phase 2 (audit DV-08): the web simulates every trade whatever DEMO_MODE says, so
   * /v1/health must never claim otherwise. DEMO_MODE=false takes effect with the Phase 3 contracts.
   */
  demoMode: true;
  logLevel: string;
  /**
   * Shared secret Nginx sends in X-Velum-Proxy-Secret (deploy/server-setup.sh generates it). When set,
   * X-Real-IP is trusted only on requests that carry it; anything else (another program on this host
   * talking to 127.0.0.1 directly) is keyed by its socket address (audit R2-I4). When empty, the API
   * trusts X-Forwarded-For from loopback as before.
   */
  proxySecret: string | null;
  /**
   * Unix socket to listen on instead of HOST:PORT_API (audit R3-03). deploy/server-setup.sh sets it to
   * /run/velum-api/api.sock: a directory only the app user and Nginx's user can enter, so no other local
   * user can take the API's address while it is down and receive what Nginx sends (the proxy secret).
   */
  socketPath: string | null;
  /**
   * Phase 3: directory of the deployment files (DEPLOYMENTS_DIR, default contracts/deployments of the
   * release). /v1/deployment, /v1/accounts/* and /v1/markets/:symbol/funding read <dir>/<CHAIN_ID>.json.
   */
  deploymentsDir?: string;
}

/** Absolute path, plain characters, short enough for sun_path (108 bytes, minus margin). */
const SOCKET_PATH_RE = /^\/[A-Za-z0-9._/-]{1,99}$/;

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

  const rawCors = (e.CORS_ORIGIN ?? '').trim();
  let corsOrigins: ApiEnv['corsOrigins'] = false;
  if (rawCors === '*') corsOrigins = true;
  else if (rawCors) {
    corsOrigins = rawCors.split(',').map((s) => s.trim()).filter(Boolean);
    for (const o of corsOrigins) if (!/^https?:\/\/[^/]+$/.test(o)) problems.push(`CORS_ORIGIN entry "${o}" must be an origin like https://velum.example (no path).`);
  }

  const proxySecret = (e.PROXY_SECRET ?? '').trim();
  if (proxySecret && !/^[0-9a-f]{32,128}$/i.test(proxySecret)) problems.push('PROXY_SECRET must be 32 to 128 hex characters (deploy/server-setup.sh generates one).');

  const socketPath = (e.API_SOCKET ?? '').trim();
  if (socketPath && (!SOCKET_PATH_RE.test(socketPath) || socketPath.split('/').includes('..'))) {
    problems.push('API_SOCKET must be an absolute path of at most 100 plain characters (letters, digits, . _ - /), e.g. /run/velum-api/api.sock.');
  }
  // On the socket no request has a client address of its own: without the proxy secret every visitor
  // would share one rate-limit bucket (audit L-3).
  if (socketPath && !proxySecret) {
    problems.push('API_SOCKET is set but PROXY_SECRET is empty: on the socket every client would share one rate limit. Set PROXY_SECRET (deploy/server-setup.sh generates one and gives it to Nginx) or clear API_SOCKET to listen on HOST:PORT_API.');
  }

  const logLevel = (e.LOG_LEVEL ?? '').trim() || (e.NODE_ENV === 'production' ? 'info' : 'debug');
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got "${e.LOG_LEVEL}").`);
  const network: NetworkName = (e.VELUM_NETWORK ?? '').trim().toLowerCase() === 'mainnet' ? 'mainnet' : NETWORK;

  const env: ApiEnv = {
    host: e.HOST || '127.0.0.1',
    port: int('PORT_API', e.PORT_API ?? e.PORT, 4000, 1, 65535),
    databaseUrl,
    redisUrl,
    redis: redis.ok ? redis.options : { db: 0 },
    corsOrigins,
    rateReadPerMin: int('RATE_LIMIT_READ_PER_MIN', e.RATE_LIMIT_READ_PER_MIN, 120, 1, 100_000),
    rateQuotePerMin: int('RATE_LIMIT_QUOTE_PER_MIN', e.RATE_LIMIT_QUOTE_PER_MIN, 30, 1, 100_000),
    rateHealthPerMin: int('RATE_LIMIT_HEALTH_PER_MIN', e.RATE_LIMIT_HEALTH_PER_MIN, 60, 1, 100_000),
    rateMarketsPerMin: int('RATE_LIMIT_MARKETS_PER_MIN', e.RATE_LIMIT_MARKETS_PER_MIN, 600, 1, 100_000),
    rpcUrl,
    chainId,
    network,
    demoMode: true,
    logLevel,
    proxySecret: proxySecret || null,
    socketPath: socketPath || null,
    deploymentsDir: (e.DEPLOYMENTS_DIR ?? '').trim() || defaultDeploymentsDir(),
  };

  if (problems.length) throw new Error(`Invalid API environment:\n  - ${problems.join('\n  - ')}`);
  return env;
}
