/**
 * Tiny in-process cache with single-flight (audit L-5, I-4): concurrent calls for one key share one
 * computation, and a result is reused for `ttlMs` (0: only concurrent calls share it). Failures are
 * never cached. Each API instance has its own; keys are few (one per route and parameters).
 */
export type Memo = <T>(key: string, ttlMs: number, fn: () => Promise<T>) => Promise<T>;

export function createMemo(now: () => number = Date.now, maxKeys = 500): Memo {
  const done = new Map<string, { at: number; value: unknown }>();
  const inflight = new Map<string, Promise<unknown>>();
  return async <T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> => {
    const hit = done.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value as T;
    const running = inflight.get(key);
    if (running) return running as Promise<T>;
    const p = fn().then(
      (value) => {
        inflight.delete(key);
        if (ttlMs > 0) {
          done.delete(key);
          done.set(key, { at: now(), value });
          if (done.size > maxKeys) done.delete(done.keys().next().value!);
        }
        return value;
      },
      (err: unknown) => {
        inflight.delete(key);
        throw err;
      },
    );
    inflight.set(key, p);
    return p;
  };
}

/**
 * A circuit breaker (audit L-4): after a failure, calls fail at once for `openMs` instead of each
 * waiting for its own timeout, so a Redis outage costs one timeout, not one per request.
 */
export function circuit(openMs: number, now: () => number = Date.now) {
  let until = 0;
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (now() < until) throw new Error('temporarily unavailable after a recent failure');
    try {
      return await fn();
    } catch (err) {
      until = now() + openMs;
      throw err;
    }
  };
}

/** Rejects when `p` takes longer than `ms` (the operation itself keeps running). */
export function timeout<T>(p: Promise<T>, ms: number, what = 'operation'): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      t.unref?.();
    }),
  ]);
}
