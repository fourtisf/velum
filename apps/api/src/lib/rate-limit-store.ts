/**
 * Rate-limit store for @fastify/rate-limit (audit L-4): counters live in Redis, so every API instance
 * shares them; when Redis errors or times out, the request is counted in a small in-memory store of
 * this process instead, so the limits keep working (per process) during a Redis outage rather than
 * switching off. Implements the store interface the plugin documents (incr, read, child).
 */
import type { Redis } from 'ioredis';
import { circuit } from './memo';

type Result = { current: number; ttl: number };
type Callback = (err: Error | null, res?: Result) => void;

/** What the plugin passes to child(): the route's merged limit options, with the route under routeInfo. */
type RouteOptions = object & { routeInfo?: { method?: unknown; url?: unknown } };

/** Atomic counter with a window: INCR, set the expiry on the first hit, return the count and TTL. */
const INCR_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {current, ttl}`;

const READ_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then return {0, 0} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then ttl = 0 end
return {tonumber(current), ttl}`;

type LimitRedis = Redis & {
  velumRateIncr?: (key: string, windowMs: number) => Promise<[number, number]>;
  velumRateRead?: (key: string) => Promise<[number, number]>;
};

/** In-memory fixed windows, at most `max` keys (oldest dropped first). */
export class MemoryWindows {
  private readonly map = new Map<string, { count: number; start: number }>();
  constructor(
    private readonly max = 10_000,
    private readonly now: () => number = Date.now,
  ) {}
  incr(key: string, windowMs: number): Result {
    const t = this.now();
    let e = this.map.get(key);
    if (!e || e.start + windowMs <= t) {
      e = { count: 0, start: t };
      this.map.delete(key);
    }
    e.count++;
    this.map.set(key, e);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return { current: e.count, ttl: e.start + windowMs - t };
  }
  read(key: string, windowMs: number): Result {
    const t = this.now();
    const e = this.map.get(key);
    if (!e || e.start + windowMs <= t) return { current: 0, ttl: 0 };
    return { current: e.count, ttl: e.start + windowMs - t };
  }
}

export interface FallbackStoreOptions {
  /** Redis for the shared counters; omitted: in-memory only (tests, local development). */
  redis?: Redis;
  /** Key prefix in Redis. */
  nameSpace?: string;
  /** Called once per Redis failure (rate limited to one call per 30 s). */
  onFallback?: (err: Error) => void;
  /** Longest wait for Redis before counting in memory. */
  timeoutMs?: number;
}

/** Builds the store class the plugin instantiates (`store` option). */
export function fallbackStore(opts: FallbackStoreOptions) {
  const redis = opts.redis as LimitRedis | undefined;
  const ns = opts.nameSpace ?? 'velum:rl:';
  const timeoutMs = opts.timeoutMs ?? 250;
  // After a Redis failure, count in memory at once for 2 s instead of waiting for a timeout per request.
  const guarded = circuit(2000);
  if (redis && !redis.velumRateIncr) {
    redis.defineCommand('velumRateIncr', { numberOfKeys: 1, lua: INCR_LUA });
    redis.defineCommand('velumRateRead', { numberOfKeys: 1, lua: READ_LUA });
  }
  let lastWarn = 0;
  const failed = (err: unknown) => {
    const now = Date.now();
    if (opts.onFallback && now - lastWarn > 30_000) {
      lastWarn = now;
      opts.onFallback(err instanceof Error ? err : new Error(String(err)));
    }
  };
  const withTimeout = <T>(p: () => Promise<T>): Promise<T> => guarded(() => raceTimeout(p()));
  const raceTimeout = <T>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`rate-limit store timed out after ${timeoutMs} ms`)), timeoutMs);
      t.unref?.();
      p.then(
        (v) => (clearTimeout(t), resolve(v)),
        (e: unknown) => (clearTimeout(t), reject(e instanceof Error ? e : new Error(String(e)))),
      );
    });

  return class FallbackStore {
    private readonly memory: MemoryWindows;
    private readonly prefix: string;
    constructor(_params?: unknown, prefix = ns, memory = new MemoryWindows()) {
      this.prefix = prefix;
      this.memory = memory;
    }
    incr(key: string, cb: Callback, timeWindow: number): void {
      if (!redis) return cb(null, this.memory.incr(key, timeWindow));
      withTimeout(() => redis.velumRateIncr!(this.prefix + key, timeWindow)).then(
        ([current, ttl]) => cb(null, { current: Number(current), ttl: Number(ttl) }),
        (err: unknown) => {
          failed(err);
          cb(null, this.memory.incr(key, timeWindow));
        },
      );
    }
    read(key: string, cb: Callback, timeWindow: number): void {
      if (!redis) return cb(null, this.memory.read(key, timeWindow));
      withTimeout(() => redis.velumRateRead!(this.prefix + key)).then(
        ([current, ttl]) => cb(null, { current: Number(current), ttl: Number(ttl) }),
        () => cb(null, this.memory.read(key, timeWindow)),
      );
    }
    child(route: RouteOptions): FallbackStore {
      const info = route.routeInfo ?? {};
      return new FallbackStore(undefined, `${this.prefix}${String(info.method)}${String(info.url)}-`, new MemoryWindows());
    }
  };
}
