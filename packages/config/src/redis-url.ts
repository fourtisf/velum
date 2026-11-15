/**
 * REDIS_URL for the API and the workers (audit M-2). Three forms:
 *   redis://[user][:password]@host[:port][/db]     TCP (the shared Redis set up by deploy/server-setup.sh)
 *   rediss://…                                     TCP with TLS
 *   unix://[user][:password]@/path/redis.sock[?db=N]
 *                                                  unix socket (the dedicated Redis of deploy/redis-velum.sh)
 * "redis+unix://" is accepted as an alias of "unix://". The password may also be given as ?password=…
 * on a socket URL. Percent-encoded characters in the user name and password are decoded. The result is
 * plain ioredis options, so every client (ioredis, BullMQ's duplicates, the rate limiter) connects the
 * same way.
 */
export interface RedisConnection {
  host?: string;
  port?: number;
  path?: string;
  db: number;
  username?: string;
  password?: string;
  tls?: Record<string, never>;
}

export type RedisUrlResult = { ok: true; options: RedisConnection } | { ok: false; error: string };

const decode = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

const DB_RE = /^\d{1,2}$/;
/** Absolute socket path of plain characters, short enough for sun_path (108 bytes, minus margin). */
const SOCKET_PATH_RE = /^\/[A-Za-z0-9._/-]{1,99}$/;

function userinfo(raw: string): { username?: string; password?: string } | null {
  const i = raw.indexOf(':');
  const user = decode(i < 0 ? raw : raw.slice(0, i));
  const pass = i < 0 ? '' : decode(raw.slice(i + 1));
  if (user === null || pass === null) return null;
  return { ...(user ? { username: user } : {}), ...(pass ? { password: pass } : {}) };
}

export function parseRedisUrl(url: string): RedisUrlResult {
  const s = (url ?? '').trim();
  const sock = /^(?:redis\+)?unix:\/\/(?:([^/?#]*)@)?(\/[^?#]*)(?:\?([^#]*))?$/i.exec(s);
  if (sock) {
    const [, auth, path, query] = sock;
    if (!SOCKET_PATH_RE.test(path!) || path!.split('/').includes('..')) {
      return { ok: false, error: 'REDIS_URL socket path must be absolute, at most 100 plain characters (letters, digits, . _ - /), e.g. unix://:PASSWORD@/run/velum-redis/redis.sock.' };
    }
    const creds = auth === undefined ? {} : userinfo(auth);
    if (creds === null) return { ok: false, error: 'REDIS_URL has an invalid percent-encoding in its user name or password.' };
    let db = 0;
    for (const pair of (query ?? '').split('&').filter(Boolean)) {
      const eq = pair.indexOf('=');
      const k = eq < 0 ? pair : pair.slice(0, eq);
      const v = decode(eq < 0 ? '' : pair.slice(eq + 1));
      if (v === null) return { ok: false, error: 'REDIS_URL has an invalid percent-encoding in its query.' };
      if (k === 'db') {
        if (!DB_RE.test(v)) return { ok: false, error: 'REDIS_URL ?db= must be a database number.' };
        db = Number(v);
      } else if (k === 'password') {
        if (v) creds.password = v;
      } else return { ok: false, error: `REDIS_URL has an unknown query parameter "${k}" (only db and password).` };
    }
    return { ok: true, options: { path: path!, db, ...creds } };
  }
  if (!/^rediss?:\/\//i.test(s)) {
    return { ok: false, error: 'REDIS_URL must be a redis://, rediss:// or unix:// URL (unix://:PASSWORD@/run/velum-redis/redis.sock for a socket).' };
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'REDIS_URL is not a valid URL (URL-encode special characters in the password).' };
  }
  if (!u.hostname) return { ok: false, error: 'REDIS_URL has no host.' };
  const dbPart = u.pathname.replace(/^\//, '');
  if (dbPart && !DB_RE.test(dbPart)) return { ok: false, error: 'REDIS_URL path must be a database number, e.g. redis://:PASSWORD@127.0.0.1:6379/5.' };
  const creds = userinfo(`${u.username}${u.password ? `:${u.password}` : ''}`);
  if (creds === null) return { ok: false, error: 'REDIS_URL has an invalid percent-encoding in its user name or password.' };
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
  return {
    ok: true,
    options: {
      host,
      port: u.port ? Number(u.port) : 6379,
      db: dbPart ? Number(dbPart) : 0,
      ...creds,
      ...(u.protocol.toLowerCase() === 'rediss:' ? { tls: {} } : {}),
    },
  };
}

/** Every password-like value inside a Redis or Postgres URL, raw and decoded, for log redaction. */
export function urlSecrets(url: string | undefined): string[] {
  if (!url) return [];
  const out = new Set<string>();
  const m = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/is.exec(url.trim());
  if (m) {
    const rest = m[1]!;
    const at = rest.lastIndexOf('@');
    if (at >= 0) {
      const info = rest.slice(0, at);
      const colon = info.indexOf(':');
      if (colon >= 0) out.add(info.slice(colon + 1));
    }
    for (const q of /[?&]password=([^&#]*)/i.exec(rest)?.slice(1) ?? []) out.add(q);
  }
  for (const v of [...out]) {
    const d = decode(v);
    if (d !== null) out.add(d);
  }
  return [...out].filter((v) => v.length >= 6);
}
