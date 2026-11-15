import type { Logger } from './log';
import { redact } from './redact';

export interface RetryOptions {
  /** First wait after a failure (doubles each time). */
  initialMs?: number;
  /** Longest wait between attempts. */
  maxMs?: number;
  /** Stops waiting (and rejects) when aborted, e.g. on SIGTERM. */
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Runs `fn` until it succeeds, waiting initialMs, 2x, 4x … up to maxMs between attempts (audit M-3).
 * Start-up uses it for Postgres and Redis: right after a reboot they may come up after the workers, and
 * a process that exits instead is marked errored by PM2 after a few fast restarts and never retried.
 * Each failure is logged (redacted). Rejects only when `signal` is aborted.
 */
export async function retryForever<T>(what: string, fn: () => Promise<T>, log: Logger, opts: RetryOptions = {}): Promise<T> {
  const { initialMs = 1000, maxMs = 30_000, signal, sleep: wait = sleep } = opts;
  let delay = initialMs;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted) throw err;
      log.warn(`${what} not reachable yet; retrying`, { attempt, retryInMs: delay, err: redact(err instanceof Error ? err.message : String(err)) });
      await wait(delay, signal);
      delay = Math.min(maxMs, delay * 2);
    }
  }
}

/** Rejects when `p` takes longer than `ms` (the underlying operation keeps running). */
export function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      t.unref?.();
    }),
  ]);
}
