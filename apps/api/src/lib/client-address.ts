import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/** Header Nginx sets on every request it proxies to the API (deploy/nginx/velum.conf, location /api/). */
export const PROXY_SECRET_HEADER = 'x-velum-proxy-secret';

const digest = (s: string) => createHash('sha256').update(s).digest();
/** What Nginx sends in X-Real-IP ($remote_addr), plus the deploy script's own probe names. */
const REAL_IP_RE = /^[0-9A-Za-z:._-]{1,64}$/;

/** The eight 16-bit groups of an IPv6 address (zone id dropped, an embedded IPv4 tail expanded), or null. */
function ipv6Groups(addr: string): number[] | null {
  let a = addr.replace(/%.*$/, '').toLowerCase();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const b = v4.slice(1).map(Number);
    if (b.some((x) => x > 255)) return null;
    a = a.slice(0, v4.index) + `${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(':').map((h) => Number.parseInt(h, 16)) : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const groups = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The rate-limit identity of an address (audit L-2). IPv4 stays as it is. An IPv6 client usually
 * controls a whole /64 (one subnet per customer or device) and could rotate through 2^64 addresses to
 * get a fresh budget per request, so IPv6 is keyed by its /64 prefix. IPv4-mapped IPv6 (::ffff:a.b.c.d,
 * how a dual-stack socket reports IPv4 clients) counts as the IPv4 address. Anything else (deploy.sh's
 * probe name in X-Real-IP) is kept as it is.
 */
export function addressKey(addr: string): string {
  const kind = isIP(addr.replace(/%.*$/, ''));
  if (kind !== 6) return addr;
  const g = ipv6Groups(addr);
  if (!g) return addr;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join('.');
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}

/** req.ip, or undefined when Fastify cannot work it out (a unix socket with trustProxy, audit L-3). */
function requestIp(req: FastifyRequest): string | undefined {
  try {
    return req.ip || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rate-limit key for a request (audit R2-I4, L-2, L-3). Other programs on a shared server can reach
 * the API locally and send any X-Forwarded-For, so with a proxy secret configured the client address
 * comes from X-Real-IP only when the request also carries the secret Nginx adds. Every other request is
 * keyed by its socket address ("local" on a unix socket), so spoofed headers neither dodge a limit nor
 * spend someone else's. Without a secret (older .env files, local development) Fastify's req.ip is used,
 * which trusts X-Forwarded-For from loopback only. Addresses go through addressKey (IPv6 by /64). The
 * generator never throws: a request whose address cannot be found falls back to a fixed key.
 */
export function clientKeyGenerator(secret: string | null): (req: FastifyRequest) => string {
  const want = secret ? digest(secret) : null;
  return (req) => {
    if (want) {
      const got = req.headers[PROXY_SECRET_HEADER];
      if (typeof got === 'string' && timingSafeEqual(digest(got), want)) {
        const real = req.headers['x-real-ip'];
        if (typeof real === 'string' && REAL_IP_RE.test(real)) return `proxy:${addressKey(real)}`;
      }
      return `direct:${addressKey(req.socket?.remoteAddress ?? 'local')}`;
    }
    return `ip:${addressKey(requestIp(req) ?? req.socket?.remoteAddress ?? 'local')}`;
  };
}
