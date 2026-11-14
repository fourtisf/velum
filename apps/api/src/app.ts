import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { AppDeps } from './lib/deps';
import { ApiError, ERROR_CODES, errorBody, type ErrorCode } from './lib/errors';
import { candlesRoutes } from './routes/candles';
import { healthRoutes } from './routes/health';
import { marketsRoutes } from './routes/markets';
import { poolsRoutes } from './routes/pools';
import { quoteRoutes } from './routes/quote';
import { statsRoutes } from './routes/stats';

export interface BuildOptions {
  logger?: boolean | { level: string };
}

/** Builds the Fastify app. All I/O goes through `deps`, so tests can pass fakes. */
export async function buildApp(deps: AppDeps, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Nginx on the same host is the only proxy; trust its X-Forwarded-For for rate limiting.
    trustProxy: 'loopback',
    bodyLimit: 16 * 1024,
    ajv: { customOptions: { coerceTypes: 'array', useDefaults: true, removeAdditional: false, allErrors: false } },
  });

  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.statusCode).send(errorBody(err.code, err.message));
    if (err.validation) {
      const msg = err.message.replace(/^(body|querystring|params)\/?/, (_m, part: string) => `${part} `).trim();
      return reply.code(400).send(errorBody('BAD_REQUEST', `Invalid request: ${msg}.`));
    }
    const status = err.statusCode ?? 500;
    if (status === 429) return reply.code(429).send(errorBody('RATE_LIMITED', err.message || 'Too many requests. Slow down and try again.'));
    if (err.code && ERROR_CODES.has(err.code)) return reply.code(status).send(errorBody(err.code as ErrorCode, err.message));
    if (status >= 400 && status < 500) return reply.code(status).send(errorBody(status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', err.message));
    req.log.error({ err }, 'request failed');
    return reply.code(500).send(errorBody('INTERNAL', 'Something went wrong on our side. Try again in a moment.'));
  });

  await app.register(cors, {
    origin: deps.env.corsOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: deps.env.rateReadPerMin,
    timeWindow: '1 minute',
    ...(deps.rateLimitRedis ? { redis: deps.rateLimitRedis as Redis, nameSpace: 'velum:rl:' } : {}),
    // Never take the API down because the rate-limit store is unreachable.
    skipOnError: true,
    errorResponseBuilder: (_req, ctx) => {
      const e = new Error(`Too many requests. Try again in ${ctx.after}.`) as Error & { statusCode: number; code: string };
      e.statusCode = 429;
      e.code = 'RATE_LIMITED';
      return e;
    },
  });

  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (req, reply) => {
    reply.code(404).send(errorBody('NOT_FOUND', `No route for ${req.method} ${req.url.split('?')[0]}.`));
  });

  await app.register(healthRoutes(deps));
  await app.register(marketsRoutes(deps));
  await app.register(candlesRoutes(deps));
  await app.register(poolsRoutes(deps));
  await app.register(statsRoutes(deps));
  await app.register(quoteRoutes(deps));

  if (deps.onClose) app.addHook('onClose', async () => deps.onClose?.());
  return app;
}
