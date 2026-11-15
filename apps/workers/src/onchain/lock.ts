/**
 * One active instance per on-chain role. PM2 runs the workers as a single fork, but during a release the old
 * and the new process overlap for a few seconds, and an operator may start a second copy by mistake: two
 * senders with one key would race for nonces, two keepers would liquidate the same position twice. Each
 * role takes a Redis lock (SET NX PX with a random owner token), renews it on every tick and releases it on
 * shutdown; a tick that does not hold it does nothing. BullMQ's job locks already serialize the ticks within
 * one queue; this lock spans processes.
 *
 * Redis is not trusted (docs/02): a co-tenant could delete the lock. The worst case is two instances sending
 * with one key, which the chain resolves (one transaction per nonce; the loser sees "nonce too low" and
 * resyncs) and the keeper's on-chain checks make harmless (a closed position is not liquidatable).
 */
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export const lockKey = (role: string): string => `velum:onchain:lock:${role}`;

export interface RoleLock {
  /** True when this instance holds the lock now (taking or renewing it). */
  hold(): Promise<boolean>;
  release(): Promise<void>;
}

export function roleLock(redis: Pick<Redis, 'set' | 'eval'>, role: string, ttlMs = 30_000): RoleLock {
  const key = lockKey(role);
  const token = randomBytes(16).toString('hex');
  let held = false;
  return {
    async hold() {
      if (held) {
        const renewed = await redis.eval(RENEW, 1, key, token, String(ttlMs));
        if (Number(renewed) === 1) return true;
        held = false;
      }
      const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
      held = ok === 'OK';
      return held;
    },
    async release() {
      if (!held) return;
      held = false;
      await redis.eval(RELEASE, 1, key, token).catch(() => undefined);
    },
  };
}
