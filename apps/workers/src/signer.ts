/**
 * velum-signer: the price relayer and the keeper, the only processes that hold hot keys (on-chain audit M-2). Runs as
 * its own Unix user in its own PM2 daemon (deploy/ecosystem.config.cjs, scope `signer`), from its own copy of the
 * release, with no Redis and no Postgres (signer/run.ts). PM2 runs it as a single fork process; a second copy waits
 * for the instance lock.
 */
import path from 'node:path';
import { createLogger } from './lib/log';
import { redact } from './lib/redact';
import { describeError } from './onchain/errors';
import { loadSignerEnv } from './signer/env';
import { StateDir } from './signer/files';
import { acquireInstanceLock, type InstanceLock } from './signer/lock';
import { idleSignerStatus, startSigner, statusWriter, type SignerHandle } from './signer/run';

const LOCK_RETRY_MS = 5000;

async function main(): Promise<void> {
  const log = createLogger();
  const startedAt = Date.now();
  const loaded = loadSignerEnv();
  let handle: SignerHandle | null = null;
  let lock: InstanceLock | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let stopping = false;

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('signer shutting down', { signal });
    setTimeout(() => process.exit(1), 10_000).unref();
    if (idleTimer) clearInterval(idleTimer);
    await handle?.stop().catch(() => undefined);
    await lock?.release().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  if (!loaded.env) {
    // Invalid settings: sign nothing, say why in /v1/health (names, never values), keep running so PM2 does not loop.
    const reason = redact(loaded.error ?? 'invalid settings');
    log.error('signer idle: invalid settings', { err: reason });
    const write = statusWriter(loaded.statusFile, log);
    const chainId = Number(process.env.CHAIN_ID) || 0;
    const tick = () => write(idleSignerStatus({ chainId, startedAt, requested: (process.env.ONCHAIN_WORKERS ?? '').trim().toLowerCase() === 'true', error: reason.replace(/\s*\n\s*-\s*/g, ' ') }));
    tick();
    idleTimer = setInterval(tick, 5000);
    return;
  }
  const env = loaded.env;

  // One instance per user: the lock is a socket in the signer's own state directory.
  try {
    const dir = new StateDir(env.stateDir).dir;
    let waited = false;
    while (!stopping) {
      lock = await acquireInstanceLock(path.join(dir, 'signer.lock'));
      if (lock) break;
      if (!waited) log.warn('another signer instance holds the lock; waiting');
      waited = true;
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  } catch (err) {
    const reason = `signer state directory or lock unusable: ${describeError(err)}`;
    log.error(reason);
    const write = statusWriter(env.statusFile, log);
    const tick = () => write(idleSignerStatus({ chainId: env.chainId, startedAt, requested: env.onchain.requested, error: reason }));
    tick();
    idleTimer = setInterval(tick, 5000);
    return;
  }
  if (stopping) return;
  handle = await startSigner({ env, log });
}

main().catch((err: unknown) => {
  // Never print secrets: RPC URLs carry API keys (the logger redacts them; so does this).
  console.error(redact(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
