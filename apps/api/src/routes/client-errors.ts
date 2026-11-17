import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps, ClientErrorRecord } from '../lib/deps';

interface ReportRoute {
  Body: { message: string; stack?: string; path?: string; release?: string; kind?: string };
}

/** Wallet addresses, keys, signatures and other long hex never leave the browser; the server scrubs again. */
export const scrub = (s: string): string => s.replace(/0x[0-9a-fA-F]{16,}/g, '0x…');

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * POST /v1/client-errors: the web reports its uncaught errors (apps/web/lib/errorReport.ts): a message, a short stack,
 * the page path (no query), the release and a kind. Limited to 10 a minute per client, logged at warn level and kept in
 * a capped list (the last 200) for GET /v1/client-errors, which answers only with the ADMIN_TOKEN header
 * (X-Velum-Admin-Token) and is 404 when no token is configured. No wallet address or user identity is accepted.
 */
export function clientErrorRoutes(deps: AppDeps): FastifyPluginAsync {
  const token = deps.env.adminToken ? digest(deps.env.adminToken) : null;
  return async (app) => {
    app.post<ReportRoute>(
      '/v1/client-errors',
      {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['message'],
            properties: {
              message: { type: 'string', minLength: 1, maxLength: 500 },
              stack: { type: 'string', maxLength: 4000 },
              path: { type: 'string', maxLength: 200 },
              release: { type: 'string', maxLength: 40 },
              kind: { type: 'string', enum: ['error', 'unhandledrejection', 'boundary'] },
            },
          },
        },
      },
      async (req, reply) => {
        const b = req.body;
        const rec: ClientErrorRecord = {
          at: (deps.now ?? Date.now)(),
          kind: b.kind ?? 'error',
          message: scrub(b.message),
          stack: b.stack ? scrub(b.stack).slice(0, 2000) : '',
          path: b.path ? scrub(b.path).split(/[?#]/)[0]!.slice(0, 200) : '',
          release: (b.release ?? '').replace(/[^\w.-]/g, '').slice(0, 40),
        };
        req.log.warn({ clientError: rec }, 'client error');
        await deps.clientErrors?.push(rec).catch(() => undefined);
        return reply.code(204).send();
      },
    );
    app.get('/v1/client-errors', async (req, reply) => {
      const got = req.headers['x-velum-admin-token'];
      if (!token || typeof got !== 'string' || !timingSafeEqual(digest(got), token)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No route for GET /v1/client-errors.' } });
      reply.header('cache-control', 'private, no-store');
      return { errors: (await deps.clientErrors?.recent(200).catch(() => [])) ?? [] };
    });
  };
}
