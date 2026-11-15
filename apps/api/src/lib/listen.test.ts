/** Regression tests for audit R3-03: the API listens on a unix socket that only its group can reach. */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../env';
import { listenOnSocket, removeStaleSocket, socketAnswers } from './listen';

// sun_path holds 108 bytes: keep the test directory short even when TMPDIR is long.
const root = tmpdir().length < 60 ? tmpdir() : '/tmp';
let dir = '';
let sock = '';
const apps: FastifyInstance[] = [];
const servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(root, 'vsock-'));
  sock = join(dir, 'api.sock');
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  rmSync(dir, { recursive: true, force: true });
});

function makeApp(): FastifyInstance {
  const app = Fastify();
  app.get('/v1/health', async () => ({ ok: true }));
  apps.push(app);
  return app;
}

const get = (path: string, url: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath: path, path: url }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });

/** A socket file left by a process that was killed (nothing accepts on it any more). */
async function staleSocket(path: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => child.stdout.once('data', r));
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
}

describe('R3-03: unix socket listener', () => {
  it('serves on the socket with mode 0660 and removes the file on close', async () => {
    const app = makeApp();
    await listenOnSocket(app, sock);
    expect(lstatSync(sock).isSocket()).toBe(true);
    expect(statSync(sock).mode & 0o777).toBe(0o660);
    expect(await get(sock, '/v1/health')).toEqual({ status: 200, body: '{"ok":true}' });
    await app.close();
    apps.length = 0;
    expect(existsSync(sock)).toBe(false);
  });

  it('replaces a stale socket left by a crash (instance 0)', async () => {
    await staleSocket(sock);
    expect(lstatSync(sock).isSocket()).toBe(true);
    expect(await socketAnswers(sock)).toBe(false);
    const app = makeApp();
    await listenOnSocket(app, sock, { instance: 0 });
    expect((await get(sock, '/v1/health')).status).toBe(200);
  });

  it('never removes a socket someone answers on, and fails instead of taking it over', async () => {
    const other = createServer((c) => c.on('error', () => undefined).end()).listen(sock);
    servers.push(other);
    await new Promise((r) => other.once('listening', r));
    expect(await removeStaleSocket(sock)).toBe(false);
    await expect(listenOnSocket(makeApp(), sock, { attempts: 2, retryMs: 10 })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(await socketAnswers(sock)).toBe(true);
  });

  it('only instance 0 removes a stale socket; other instances wait for it', async () => {
    await staleSocket(sock);
    await expect(listenOnSocket(makeApp(), sock, { instance: 1, attempts: 2, retryMs: 10 })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(lstatSync(sock).isSocket()).toBe(true);
  });

  it('leaves files that are not sockets alone', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(sock, 'not a socket');
    expect(await removeStaleSocket(sock)).toBe(false);
    expect(existsSync(sock)).toBe(true);
  });

  it('API_SOCKET is validated', () => {
    const base = { DATABASE_URL: 'postgresql://a', REDIS_URL: 'redis://b' };
    expect(loadEnv(base).socketPath).toBeNull();
    expect(loadEnv({ ...base, API_SOCKET: '/run/velum-api/api.sock' }).socketPath).toBe('/run/velum-api/api.sock');
    for (const bad of ['run/api.sock', '/run/velum api/api.sock', '/run/../etc/api.sock', `/run/${'a'.repeat(120)}.sock`, '/run/x;y.sock']) {
      expect(() => loadEnv({ ...base, API_SOCKET: bad })).toThrow(/API_SOCKET/);
    }
  });
});
