import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/** Header Nginx sets on every request it proxies to the API (deploy/nginx/velum.conf, location /api/). */
export const PROXY_SECRET_HEADER = 'x-velum-proxy-secret';

const digest = (s: string) => createHash('sha256').update(s).digest();
/** What Nginx sends in X-Real-IP ($remote_addr), plus the deploy script's own probe names. */
const REAL_IP_RE = /^[0-9A-Za-z:._-]{1,64}$/;

/**
 * Rate-limit key for a request (audit R2-I4). Other programs on a shared server can reach the API on
 * 127.0.0.1 and send any X-Forwarded-For, so with a proxy secret configured the client address comes
 * from X-Real-IP only when the request also carries the secret Nginx adds. Every other request is
 * keyed by its socket address, so spoofed headers neither dodge a limit nor spend someone else's.
 * Returns null when no secret is configured (then Fastify trusts X-Forwarded-For from loopback).
 */
export function clientKeyGenerator(secret: string | null): ((req: FastifyRequest) => string) | null {
  if (!secret) return null;
  const want = digest(secret);
  return (req) => {
    const got = req.headers[PROXY_SECRET_HEADER];
    if (typeof got === 'string' && timingSafeEqual(digest(got), want)) {
      const real = req.headers['x-real-ip'];
      if (typeof real === 'string' && REAL_IP_RE.test(real)) return `proxy:${real}`;
    }
    return `direct:${req.socket.remoteAddress ?? 'unknown'}`;
  };
}
