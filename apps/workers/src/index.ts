/**
 * Velum workers (Phase 2): price-relay and candles on BullMQ, plus an hourly tick prune.
 * Runs as a single PM2 fork process (deploy/ecosystem.config.cjs).
 */
import { PrismaClient } from '@velum/db';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { demoBackfill, loadSeries, loadSnapshots, resetHistoryOnSourceChange, upsertMarkets } from './bootstrap';
import { CANDLES_WORKER, PRICE_WORKER, type CandleJobData, type WorkerContext } from './context';
import { loadEnv } from './env';
import { CANDLE_JOB_OPTIONS, runCandles, writeCandleCaches } from './jobs/candles';
import { runPriceRelay } from './jobs/price-relay';
import { runPrune } from './jobs/prune';
import { createLogger } from './lib/log';
import { redactUrls } from './lib/redact';
import { pickSource } from './sources';

const Q_PRICES = 'velum-prices';
const Q_CANDLES = 'velum-candles';
const Q_MAINTENANCE = 'velum-maintenance';

async function main(): Promise<void> {
  const log = createLogger();
  const env = loadEnv();

  const prisma = new PrismaClient({ datasources: { db: { url: env.databaseUrl } } });
  // BullMQ needs maxRetriesPerRequest: null; it duplicates this connection for blocking calls.
  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  redis.on('error', (err) => log.warn('redis error', { err: err.message }));

  const marketIds = await upsertMarkets(prisma);
  // Never mix simulated and real price history (see resetHistoryOnSourceChange).
  await resetHistoryOnSourceChange(prisma, redis, env.priceSource, log);
  const snapshots = await loadSnapshots(redis);
  let series = await loadSeries(prisma, marketIds);
  if (env.priceSource === 'demo') {
    const seeded = await demoBackfill(prisma, redis, marketIds, snapshots, series, env.pricePollMs, log);
    if (seeded.candlesInserted) series = await loadSeries(prisma, marketIds);
  }
  await writeCandleCaches(redis, series);

  const defaultJobOptions = { removeOnComplete: true, removeOnFail: 200 } as const;
  const prices = new Queue(Q_PRICES, { connection: redis, defaultJobOptions });
  const candles = new Queue<CandleJobData>(Q_CANDLES, { connection: redis, defaultJobOptions });
  const maintenance = new Queue(Q_MAINTENANCE, { connection: redis, defaultJobOptions });

  const ctx: WorkerContext = {
    env,
    prisma,
    redis,
    log,
    source: pickSource(env.priceSource, env.rpcUrl, log),
    marketIds,
    snapshots,
    open24h: new Map([...snapshots].map(([k, v]) => [k, v.open24h])),
    lastOpenRefresh: 0,
    series,
    lastTickAt: new Map(),
    // A failed candle write is retried (audit L9); runCandles keeps retries from rewinding closes.
    enqueueCandles: async (data) => {
      await candles.add('tick', data, CANDLE_JOB_OPTIONS);
    },
  };

  await prices.upsertJobScheduler(PRICE_WORKER, { every: env.pricePollMs }, { name: 'tick', opts: defaultJobOptions });
  await maintenance.upsertJobScheduler('prune-ticks', { every: 3_600_000 }, { name: 'prune', opts: defaultJobOptions });

  const workers = [
    new Worker(Q_PRICES, async () => runPriceRelay(ctx), { connection: redis, concurrency: 1 }),
    new Worker<CandleJobData>(Q_CANDLES, async (job: Job<CandleJobData>) => runCandles(ctx, job.data), { connection: redis, concurrency: 1 }),
    new Worker(Q_MAINTENANCE, async () => runPrune(ctx), { connection: redis, concurrency: 1 }),
  ];
  for (const w of workers) {
    w.on('failed', (job, err) => log.error('job failed', { queue: w.name, job: job?.name, err: err.message }));
    w.on('error', (err) => log.error('worker error', { queue: w.name, err: err.message }));
  }

  log.info('workers started', {
    workers: [PRICE_WORKER, CANDLES_WORKER, 'prune'],
    source: ctx.source.name,
    pollMs: env.pricePollMs,
    demoMode: env.demoMode,
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info('shutting down', { signal });
    setTimeout(() => process.exit(1), 10_000).unref();
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled([prices.close(), candles.close(), maintenance.close()]);
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // Never print RPC, database or Redis URLs: they carry API keys and passwords (audit L7).
  console.error(redactUrls(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
