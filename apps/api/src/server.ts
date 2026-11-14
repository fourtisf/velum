import { PrismaClient } from '@velum/db';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { loadEnv } from './env';
import { prismaDb, redisCache, viemChain } from './lib/adapters';

async function main(): Promise<void> {
  const env = loadEnv();

  const prisma = new PrismaClient({ datasources: { db: { url: env.databaseUrl } } });
  const redis = new Redis(env.redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 2000,
    enableAutoPipelining: true,
  });
  redis.on('error', () => {
    /* surfaced through /v1/health; ioredis keeps reconnecting */
  });

  const app = await buildApp(
    {
      env,
      cache: redisCache(redis),
      db: prismaDb(prisma),
      chain: viemChain(env.rpcUrl),
      rateLimitRedis: redis,
      onClose: async () => {
        await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
      },
    },
    { logger: { level: env.logLevel } },
  );

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

  await app.listen({ host: env.host, port: env.port });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
