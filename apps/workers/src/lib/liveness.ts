import { cacheKeys } from '@velum/config';
import type { Redis } from 'ioredis';
import type { Logger } from './log';

/** Redis heartbeat name; the API reports its age as `workers` in GET /v1/health (apps/api/src/routes/health.ts). */
export const WORKERS_HEARTBEAT = 'workers';
export const LIVENESS_INTERVAL_MS = 5000;

/**
 * Writes the process liveness heartbeat now and every `intervalMs`, whether or not the price source
 * has quotes (a closed market or an upstream outage must not look like a dead process). deploy/deploy.sh
 * waits for a beat written after a release started, so call this only once start-up has succeeded
 * (audit R2-L5). Returns a stop function.
 */
export async function startLiveness(redis: Pick<Redis, 'set'>, log: Logger, intervalMs = LIVENESS_INTERVAL_MS, now = Date.now): Promise<() => void> {
  const beat = () =>
    redis.set(cacheKeys.heartbeat(WORKERS_HEARTBEAT), String(now())).then(
      () => undefined,
      (err: unknown) => log.warn('liveness heartbeat failed', { err: err instanceof Error ? err.message : String(err) }),
    );
  await beat();
  const timer = setInterval(() => void beat(), intervalMs);
  return () => clearInterval(timer);
}
