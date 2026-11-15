/**
 * Velum workers: price-relay and candles on BullMQ, plus an hourly tick prune (Phase 2), and the Phase 3 indexer
 * (onchain/index.ts), off unless ONCHAIN_WORKERS=true and the chain's deployment file exists. Runs as a single PM2 fork
 * process (deploy/ecosystem.config.cjs). The price relayer and the keeper, which hold the hot keys, run in their own
 * process as their own user (velum-signer, src/signer.ts; on-chain audit M-2): this process never signs anything.
 */
import { createCacheMac } from '@velum/config/src/cache-mac';
import { SIGNER_HOT_KEYS } from '@velum/config/src/onchain';
import { PrismaClient } from '@velum/db';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { demoBackfill, loadLastTickAt, loadLastTickPrices, loadSeries, loadSnapshots, prepareHistory, retagUnknownCandles, upsertMarkets } from './bootstrap';
import { CANDLES_WORKER, PRICE_WORKER, type CandleJobData, type WorkerContext } from './context';
import { loadEnv } from './env';
import { CANDLE_JOB_OPTIONS, candleJobFromTicks, runCandles, writeCandleCaches } from './jobs/candles';
import { runPriceRelay } from './jobs/price-relay';
import { runPrune } from './jobs/prune';
import { startChainCheck } from './lib/chain';
import { startLiveness } from './lib/liveness';
import { createLogger } from './lib/log';
import { redact } from './lib/redact';
import { retryForever, timeout } from './lib/retry';
import { loadOnchainSettings, type OnchainEnv } from './onchain/env';
import { redisRefusal, removeOnchainSchedulers, startDisabledStatus, startOnchain, type OnchainHandle } from './onchain/index';
import { pickSource } from './sources';

/** Start-up tags candles of unknown source whose bucket ended in this window; the rest follows in the background. */
const RECENT_RETAG_MS = 2 * 86_400_000;

const Q_PRICES = 'velum-prices';
const Q_CANDLES = 'velum-candles';
const Q_MAINTENANCE = 'velum-maintenance';

/** Set once SIGTERM/SIGINT arrived: start-up retries stop, and their rejection is not an error. */
const stop = new AbortController();

async function main(): Promise<void> {
  const log = createLogger();
  const env = loadEnv();
  // An invalid on-chain setting disables only the on-chain workers (audit I-2): the Phase 2 price and candle
  // workers keep running, the problem is logged, and /v1/health shows it while ONCHAIN_WORKERS asks for them.
  // The messages name variables, never their values.
  const settings = loadOnchainSettings();
  const onchainEnv: OnchainEnv | null = settings.env;
  let onchainDisabled: string | null = settings.disabled === null ? null : redact(settings.disabled);
  if (settings.error) log.error('on-chain workers disabled: invalid on-chain settings; the price and candle workers keep running', { err: redact(settings.error) });
  const strayKeys = SIGNER_HOT_KEYS.filter((k) => (process.env[k] ?? '').trim() !== '');
  if (strayKeys.length) log.warn('hot keys in the workers environment are never used: they belong in the signer keys file (deploy/new-key.sh)', { names: strayKeys.join(',') });

  const prisma = new PrismaClient({ datasources: { db: { url: env.databaseUrl } } });
  // BullMQ needs maxRetriesPerRequest: null; it duplicates this connection for blocking calls. REDIS_URL
  // may name a TCP Redis or a unix socket (deploy/redis-velum.sh): env.redis holds the parsed options.
  const redis = new Redis({ ...env.redis, maxRetriesPerRequest: null, connectTimeout: 5000 });
  redis.on('error', (err) => log.warn('redis error', { err: err.message }));
  // Snapshots, candle caches and heartbeats are authenticated with a key derived from DATABASE_URL,
  // which the API also has and a tenant of a shared Redis does not (audit F-2).
  const mac = createCacheMac(env.databaseUrl, env.network);

  // A signal during start-up (while waiting for Postgres or Redis) exits at once; replaced below.
  let shutdown = async (signal: string): Promise<void> => {
    stop.abort();
    log.info('shutting down during start-up', { signal });
    setTimeout(() => process.exit(0), 2000).unref();
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Start-up waits for Postgres and Redis with backoff instead of exiting (audit M-3): after a reboot
  // they may start after PM2, and PM2 marks a process that keeps exiting within a second as errored.
  // Liveness starts only once start-up succeeded, so /v1/health reports the workers as stale until then.
  const retry = <T>(what: string, fn: () => Promise<T>) => retryForever(what, fn, log, { signal: stop.signal });
  await retry('Redis', () => timeout(redis.ping(), 5000, 'Redis ping'));
  await retry('PostgreSQL', () => prisma.$queryRaw`SELECT 1`);
  const chain = startChainCheck(env.rpcUrl, env.chainId, log, { signal: stop.signal });

  const { marketIds, snapshots, series, lastTickAt, lastTickPrice } = await retry('start-up (PostgreSQL and Redis)', async () => {
    const marketIds = await upsertMarkets(prisma);
    // Never mix simulated and real price history, never delete it on a guess: only positive evidence of
    // the other kind of source resets, candles of unknown source never count and are tagged where their
    // stored ticks prove the source (audit F-1, F-4). Rows dated ahead are dropped (audit L-1).
    // Only the recent candles are tagged here (the buckets this process may still write and the series it
    // loads next); older ones are tagged in the background once the workers are alive (audit N-1).
    await prepareHistory(prisma, redis, env.priceSource, log, { since: new Date(Date.now() - RECENT_RETAG_MS), timeoutMs: 10_000, budgetMs: 20_000 });
    const snapshots = await loadSnapshots(redis, mac);
    let series = await loadSeries(prisma, marketIds, env.priceSource);
    if (env.priceSource === 'demo') {
      const seeded = await demoBackfill(prisma, redis, mac, marketIds, snapshots, series, env.pricePollMs, log);
      if (seeded.candlesInserted) series = await loadSeries(prisma, marketIds, env.priceSource);
    }
    await writeCandleCaches(redis, mac, env.priceSource, series);
    // After the reset above, so ticks of a cleared source never count (audit R2-L1).
    const lastTickAt = await loadLastTickAt(prisma, marketIds);
    const lastTickPrice = await loadLastTickPrices(prisma, marketIds, env.priceSource);
    return { marketIds, snapshots, series, lastTickAt, lastTickPrice };
  });

  const defaultJobOptions = { removeOnComplete: true, removeOnFail: 200 } as const;
  const prices = new Queue(Q_PRICES, { connection: redis, defaultJobOptions });
  const candles = new Queue<CandleJobData>(Q_CANDLES, { connection: redis, defaultJobOptions });
  const maintenance = new Queue(Q_MAINTENANCE, { connection: redis, defaultJobOptions });

  const ctx: WorkerContext = {
    env,
    prisma,
    redis,
    log,
    source: pickSource(env.priceSource, env.rpcUrl, log, () => chain.state() !== 'mismatch'),
    marketIds,
    snapshots,
    open24h: new Map([...snapshots].map(([k, v]) => [k, v.open24h])),
    lastOpenRefresh: 0,
    series,
    lastTickAt,
    lastTickPrice,
    mac,
    // A failed candle write is retried (audit L9); runCandles keeps retries from rewinding closes.
    enqueueCandles: async (data) => {
      await candles.add('tick', data, CANDLE_JOB_OPTIONS);
    },
  };

  await retry('job schedulers (Redis)', async () => {
    await prices.upsertJobScheduler(PRICE_WORKER, { every: env.pricePollMs }, { name: 'tick', opts: defaultJobOptions });
    await maintenance.upsertJobScheduler('prune-ticks', { every: 3_600_000 }, { name: 'prune', opts: defaultJobOptions });
  });

  // Candle writes and the background history reload below never overlap (one in-process queue), so a
  // reload can never drop a candle a job is advancing.
  let historyTail: Promise<unknown> = Promise.resolve();
  const withHistory = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = historyTail.then(fn, fn);
    historyTail = run.catch(() => undefined);
    return run;
  };

  const workers = [
    new Worker(Q_PRICES, async () => runPriceRelay(ctx), { connection: redis, concurrency: 1 }),
    // A queued job's payload is not trusted (audit M-2): the tick is read back from Postgres.
    new Worker<CandleJobData>(
      Q_CANDLES,
      async (job: Job<CandleJobData>) =>
        withHistory(async () => {
          const data = await candleJobFromTicks(ctx, job.data);
          return data ? runCandles(ctx, data) : 0;
        }),
      { connection: redis, concurrency: 1 },
    ),
    new Worker(Q_MAINTENANCE, async () => runPrune(ctx), { connection: redis, concurrency: 1 }),
  ];
  for (const w of workers) {
    w.on('failed', (job, err) => log.error('job failed', { queue: w.name, job: job?.name, err: err.message }));
    w.on('error', (err) => log.error('worker error', { queue: w.name, err: err.message }));
  }

  // Liveness for /v1/health and deploy.sh's post-release check (audit R2-L5): only once start-up worked.
  const stopLiveness = await startLiveness(redis, mac, log);

  // Older candles of unknown source (written by a release before the source tag existed) are tagged now,
  // market by market with a timeout, then the in-memory series and candle caches are reloaded so charts
  // show that history (audit N-1, F-1). A failure leaves them unknown until the next start.
  void withHistory(async () => {
    const tagged = await retagUnknownCandles(prisma, log, { timeoutMs: 120_000 });
    if (tagged > 0) {
      ctx.series = await loadSeries(prisma, marketIds, env.priceSource);
      await writeCandleCaches(redis, mac, env.priceSource, ctx.series);
    }
  }).catch((err: unknown) => log.warn('background candle tagging failed; tried again on the next start', { err: redact(String(err)) }));

  // Phase 3: the indexer, only with ONCHAIN_WORKERS=true and a deployment file for this chain, and only on Velum's own
  // Redis over a unix socket (audit M-3). Started after liveness and without any RPC call, so the chain can never hold
  // up the Phase 2 workers. (The relayer and keeper run in velum-signer.)
  if (onchainEnv?.requested && redisRefusal(redis)) {
    onchainDisabled = redisRefusal(redis);
    log.error('on-chain workers off', { reason: onchainDisabled });
  }
  const runEnv = onchainDisabled ? null : onchainEnv;
  const onchain: OnchainHandle | null = await retry('on-chain workers (Redis)', async () => {
    const h = runEnv ? await startOnchain({ env: runEnv, chainId: env.chainId, rpcUrl: env.rpcUrl, prisma, redis, mac, log }) : null;
    if (!h) await removeOnchainSchedulers(redis);
    return h;
  });
  const stopDisabledStatus = onchainDisabled ? startDisabledStatus({ redis, mac, chainId: env.chainId, reason: onchainDisabled, log }) : null;

  log.info('workers started', {
    workers: [PRICE_WORKER, CANDLES_WORKER, 'prune', ...(onchain ? ['onchain'] : [])],
    onchainDisabled: onchainDisabled ?? undefined,
    source: ctx.source.name,
    pollMs: env.pricePollMs,
    demoMode: env.demoMode,
    network: env.network,
    redis: env.redis.path ? 'unix socket' : 'tcp',
  });

  let closing = false;
  shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    stop.abort();
    log.info('shutting down', { signal });
    setTimeout(() => process.exit(1), 10_000).unref();
    stopLiveness();
    stopDisabledStatus?.();
    await onchain?.stop().catch(() => undefined);
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled([prices.close(), candles.close(), maintenance.close()]);
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
    process.exit(0);
  };
}

main().catch((err: unknown) => {
  if (stop.signal.aborted) return; // stopped during start-up: the shutdown handler exits
  // Never print secrets: RPC, database or Redis URLs carry API keys and passwords (audit L7, L-6).
  console.error(redact(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
