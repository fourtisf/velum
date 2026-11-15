/**
 * One signer at a time. Two signers with the same keys would race for nonces and liquidate the same position twice
 * (harmless on chain, wasted gas), so the signer holds a lock: a unix socket it listens on in its own state directory
 * (0700, so only the signer user can take, squat or remove it; the Redis role locks the workers used could be held by
 * anyone with access to that Redis). A second instance finds the socket answering and waits; a socket left by a crash
 * answers nothing and is replaced.
 */
import { lstatSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';

export interface InstanceLock {
  release(): Promise<void>;
}

function listen(path: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((sock) => sock.end());
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = createConnection(path);
    const done = (v: boolean) => {
      c.destroy();
      resolve(v);
    };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    setTimeout(() => done(false), 1000).unref();
  });
}

/** The lock, or null while another live instance holds it. Throws on anything unexpected (permissions, a non-socket). */
export async function acquireInstanceLock(path: string): Promise<InstanceLock | null> {
  let server: Server;
  try {
    server = await listen(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    if (await answers(path)) return null;
    const st = lstatSync(path);
    if (!st.isSocket() || st.uid !== process.getuid?.()) throw new Error(`${path} is not this user's lock socket`);
    unlinkSync(path);
    server = await listen(path);
  }
  return {
    release: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
