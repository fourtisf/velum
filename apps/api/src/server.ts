import { createGeo } from './lib/geo';
import type { ClientErrorRecord } from './lib/deps';
import { once } from 'node:events';
import { createCacheMac } from '@velum/config/src/cache-mac';
import { PrismaClient } from '@velum/db';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { loadEnv } from './env';
import { fileSigner, prismaDb, redisCache, viemChain } from './lib/adapters';
import { listenOnSocket } from './lib/listen';
import { deploymentSource, prismaOnchain } from './lib/onchain';
import { redact } from './lib/redact';

/** Error serializer for the request log: messages and stacks pass through redact() (audit L-6). */
const errSerializer = (e: unknown) => {
  if (!(e instanceof Error)) return { message: redact(String(e)) };
  const code = (e as { code?: unknown }).code;
  return { type: e.name, message: redact(e.message), stack: e.stack ? redact(e.stack) : undefined, ...(code !== undefined ? { code } : {}) };
};

async function main(): Promise<void> {
  const env = loadEnv();

  const prisma = new PrismaClient({ datasources: { db: { url: env.databaseUrl } } });
  // REDIS_URL may name a TCP Redis or the unix socket of deploy/redis-velum.sh (env.redis, audit M-2).
  // Requests never wait for Redis (audit L-4): no offline queue (a command fails at once while Redis is
  // unreachable), short command timeouts; the routes then answer from memory, marked stale.
  const redis = new Redis({
    ...env.redis,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 500,
    enableOfflineQueue: false,
    enableAutoPipelining: true,
  });
  redis.on('error', () => {
    /* surfaced through /v1/health; ioredis keeps reconnecting */
  });
  // Give the first connection a moment so the first requests after a (re)start are not answered degraded.
  await Promise.race([once(redis, 'ready'), new Promise((r) => setTimeout(r, 2000).unref())]).catch(() => undefined);

  const chain = viemChain(env.rpcUrl);
  // Cached values are authenticated with a key derived from DATABASE_URL, which the workers also have
  // and a tenant of a shared Redis does not (audit F-2).
  const mac = createCacheMac(env.databaseUrl, env.network);
  const app = await buildApp(
    {
      env,
      cache: redisCache(redis, { mac }),
      signer: env.signerStatusFile ? fileSigner(env.signerStatusFile) : undefined,
      db: prismaDb(prisma),
      chain,
      deployment: deploymentSource(env.deploymentsDir ?? '', env.chainId),
      onchain: prismaOnchain(prisma),
      rateLimitRedis: redis,
      geo: createGeo({ header: env.geoHeader, dbPath: env.geoipDb, proxySecret: env.proxySecret, onError: (msg) => console.warn(msg) }),
      clientErrors: {
        push: async (rec) => {
          await redis.multi().lpush('velum:client-errors', JSON.stringify(rec)).ltrim('velum:client-errors', 0, 199).exec();
        },
        recent: async (n) => (await redis.lrange('velum:client-errors', 0, Math.max(0, n - 1))).map((s) => JSON.parse(s) as ClientErrorRecord),
      },
      alerts: {
        putCode: async (code, address, ttl) => {
          await redis.set(`velum:alerts:code:${code}`, address, 'EX', ttl);
        },
      },
      referrals: {
        attribute: async (address, code) => {
          const set = await redis.set(`velum:ref:addr:${address}`, code, 'NX');
          if (set !== 'OK') return false;
          await redis.incr(`velum:ref:count:${code}`);
          return true;
        },
        count: async (code) => Number((await redis.get(`velum:ref:count:${code}`)) ?? 0),
      },
      onClose: async () => {
        await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
      },
    },
    { logger: { level: env.logLevel, serializers: { err: errSerializer } } },
  );

  // RPC_URL must serve CHAIN_ID (audit I-5). Checked in the background: an unreachable RPC only warns
  // (and is checked again by /v1/health); a wrong chain makes /v1/health answer 503 (ok: false).
  void chain.chainId?.().then((got) => {
    if (got === null) app.log.warn({ expected: env.chainId }, 'RPC unreachable at start; chain id not verified yet');
    else if (got !== env.chainId) app.log.error({ expected: env.chainId, got }, 'RPC_URL serves another chain than CHAIN_ID; /v1/health reports unhealthy');
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    app.close().then(
      () => process.exit(0),
      (err) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  if (env.socketPath) {
    // On the server: a unix socket only the app user and Nginx can reach (audit R3-03).
    await listenOnSocket(app, env.socketPath, { instance: Number(process.env.NODE_APP_INSTANCE) || 0 });
  } else {
    await app.listen({ host: env.host, port: env.port });
  }
}

main().catch((err: unknown) => {
  // Never print secrets: RPC, database or Redis URLs carry API keys and passwords (audit L7, L-6).
  console.error(redact(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
