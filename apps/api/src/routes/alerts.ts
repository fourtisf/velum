import { randomBytes } from 'node:crypto';
import { ALERTS_CODE_TTL_S, ALERTS_SIG_MAX_AGE_MS, REF_CODE_RE, alertsMessage, refCode } from '@velum/config/src/alerts';
import type { FastifyPluginAsync } from 'fastify';
import { isAddress, recoverMessageAddress, type Hex } from 'viem';
import type { AppDeps } from '../lib/deps';
import { ApiError } from '../lib/errors';

interface CodeRoute {
  Body: { address: string; issuedAt: string; signature: string };
}
interface RefRoute {
  Body: { address: string; code: string };
}

/**
 * Telegram alerts (apps/workers/src/alerts.ts) and referral links.
 *  GET  /v1/alerts           whether alerts are on, and the bot's username (TELEGRAM_BOT_USERNAME).
 *  POST /v1/alerts/code      a one-time code (15 minutes) for the bot, for a wallet that signed alertsMessage within 10
 *                            minutes; the bot links the chat that opens it to that wallet.
 *  POST /v1/referrals        records, once per wallet, the referral code it arrived with (not its own).
 *  GET  /v1/referrals/:code  how many wallets arrived through a code. Counts only: no rewards are attached.
 */
export function alertsRoutes(deps: AppDeps): FastifyPluginAsync {
  const bot = deps.env.telegramBot ?? null;
  return async (app) => {
    app.get('/v1/alerts', async () => ({ enabled: !!bot && !!deps.alerts, bot }));
    app.post<CodeRoute>(
      '/v1/alerts/code',
      {
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['address', 'issuedAt', 'signature'],
            properties: {
              address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
              issuedAt: { type: 'string', maxLength: 40 },
              signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$' },
            },
          },
        },
      },
      async (req) => {
        if (!bot || !deps.alerts) throw new ApiError(404, 'NOT_FOUND', 'Telegram alerts are not set up on this server.');
        const { address, issuedAt, signature } = req.body;
        const t = Date.parse(issuedAt);
        const now = (deps.now ?? Date.now)();
        if (!Number.isFinite(t) || Math.abs(now - t) > ALERTS_SIG_MAX_AGE_MS) throw new ApiError(400, 'BAD_REQUEST', 'The signature is too old. Sign again.');
        let signer: string;
        try {
          signer = await recoverMessageAddress({ message: alertsMessage(address, issuedAt), signature: signature as Hex });
        } catch {
          throw new ApiError(400, 'BAD_REQUEST', 'The signature could not be read. Sign again.');
        }
        if (signer.toLowerCase() !== address.toLowerCase()) throw new ApiError(400, 'BAD_REQUEST', 'The signature is not from this wallet.');
        const code = randomBytes(16).toString('base64url');
        await deps.alerts.putCode(code, address.toLowerCase(), ALERTS_CODE_TTL_S);
        return { code, url: `https://t.me/${bot}?start=${code}`, expiresIn: ALERTS_CODE_TTL_S };
      },
    );
    app.post<RefRoute>(
      '/v1/referrals',
      {
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['address', 'code'],
            properties: { address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' }, code: { type: 'string', pattern: REF_CODE_RE.source } },
          },
        },
      },
      async (req) => {
        const { address, code } = req.body;
        if (!deps.referrals || !isAddress(address)) return { attributed: false };
        if (refCode(address) === code) return { attributed: false };
        return { attributed: await deps.referrals.attribute(address.toLowerCase(), code) };
      },
    );
    app.get<{ Params: { code: string } }>(
      '/v1/referrals/:code',
      { schema: { params: { type: 'object', properties: { code: { type: 'string', pattern: REF_CODE_RE.source } }, required: ['code'] } } },
      async (req) => ({ code: req.params.code, friends: deps.referrals ? await deps.referrals.count(req.params.code) : 0 }),
    );
  };
}
