import { chmod, lstat, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import type { FastifyInstance } from 'fastify';

/** True when a process accepts connections on the unix socket at `path`. */
export function socketAnswers(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ path });
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve(v);
    };
    s.once('connect', () => done(true));
    s.on('error', () => done(false));
    // Accepted by the kernel but slow to answer still means someone is listening: keep the file.
    s.setTimeout(timeoutMs, () => done(true));
  });
}

/** Removes `path` only when it is a socket file nobody accepts connections on (left by a crash). */
export async function removeStaleSocket(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => null);
  if (!st || !st.isSocket()) return false;
  if (await socketAnswers(path)) return false;
  await unlink(path).catch(() => undefined);
  return true;
}

export interface SocketListenOptions {
  /** PM2 instance number (NODE_APP_INSTANCE). Only instance 0 removes a stale socket file. */
  instance?: number;
  attempts?: number;
  retryMs?: number;
}

/**
 * Listens on a unix socket (audit R3-03) and makes it reachable for its group: the directory is
 * created by root (tmpfiles.d), owned by the app user, group Nginx's user, setgid, 2750, so the socket
 * gets that group and only the app user and Nginx can reach it.
 *
 * PM2 cluster mode: the cluster primary (the PM2 daemon) binds the path once and every worker shares
 * it, so a zero-downtime reload starts new workers on the same socket. libuv removes the file when the
 * last worker closes it; only a crash leaves it behind. Such a stale file is removed before listening,
 * but only when nothing answers on it and only by instance 0, so two workers starting together never
 * remove each other's fresh socket. Other instances retry while instance 0 cleans up.
 */
export async function listenOnSocket(app: FastifyInstance, path: string, opts: SocketListenOptions = {}): Promise<void> {
  const { instance = 0, attempts = 20, retryMs = 250 } = opts;
  for (let i = 1; ; i++) {
    if (instance === 0) await removeStaleSocket(path);
    try {
      await app.listen({ path });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
  // Created with the process umask (0750 under PM2): Nginx's group needs write access to connect.
  await chmod(path, 0o660);
}
