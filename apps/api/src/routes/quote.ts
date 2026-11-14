import { DEMO, PROTOCOL, QUOTE_SYMBOL, getMarket } from '@velum/config';
import { WAD, parseWad, pctToWad, roundSig, roundTo, swapHops, swapQuote, toDecimalString, type Wad } from '@velum/math';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';
import { ApiError, badRequest } from '../lib/errors';
import { isFresh } from '../lib/market-view';

/** Quotes are rounded so they can't be used to back out pool reserves. */
export const QUOTE_SIG_FIGS = 4;
const MAX_AMOUNT: Wad = 10n ** 12n * WAD;
const SLIPPAGE = pctToWad(PROTOCOL.defaultSlippagePct);

interface QuoteBody {
  from: string;
  to: string;
  amount: string;
}

const sig = (w: Wad) => toDecimalString(roundSig(w, QUOTE_SIG_FIGS, 'floor'));

export function quoteRoutes(deps: AppDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  return async (app) => {
    app.post<{ Body: QuoteBody }>(
      '/v1/quote',
      {
        bodyLimit: 4096,
        config: { rateLimit: { max: deps.env.rateQuotePerMin, timeWindow: '1 minute' } },
        schema: {
          body: {
            type: 'object',
            required: ['from', 'to', 'amount'],
            additionalProperties: false,
            properties: {
              from: { type: 'string', minLength: 1, maxLength: 12 },
              to: { type: 'string', minLength: 1, maxLength: 12 },
              amount: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[0-9]+(\\.[0-9]+)?$' },
            },
          },
        },
      },
      async (req) => {
        const from = req.body.from.trim().toUpperCase();
        const to = req.body.to.trim().toUpperCase();
        for (const sym of [from, to]) {
          if (sym === QUOTE_SYMBOL) continue;
          const m = getMarket(sym);
          if (!m) throw badRequest(`Unknown token ${sym}. Use USDG or a market symbol such as TSLA.`);
          if (m.status !== 'live') throw new ApiError(400, 'MARKET_CLOSED', `${sym} isn't on Robinhood Chain testnet yet.`);
        }
        if (from === to) throw badRequest('Choose two different tokens.');

        const amount = parseWad(req.body.amount) ?? 0n;
        if (amount <= 0n) throw badRequest('Amount must be above zero.');
        if (amount > MAX_AMOUNT) throw badRequest('Amount is too large.');

        const stocks = [from, to].filter((s) => s !== QUOTE_SYMBOL);
        const snaps = await deps.cache.snapshots(stocks);
        const t = now();
        const price = (sym: string): Wad => {
          if (sym === QUOTE_SYMBOL) return WAD;
          const snap = snaps.get(sym);
          if (!isFresh(snap, t)) throw new ApiError(503, 'STALE_PRICE', `The ${sym} price is out of date. Try again in a moment.`);
          const p = parseWad(snap.price);
          if (p === null || p <= 0n) throw new ApiError(503, 'STALE_PRICE', `The ${sym} price is out of date. Try again in a moment.`);
          return p;
        };

        const hops = swapHops(from, to, QUOTE_SYMBOL);
        const q = swapQuote(amount, price(from), price(to), hops, SLIPPAGE, PROTOCOL, DEMO);
        return {
          out: sig(q.out),
          min: sig(q.min),
          hops,
          route: hops === 2 ? [from, QUOTE_SYMBOL, to] : [from, to],
          feeUsd: toDecimalString(roundTo(q.fee, 2, 'ceil'), 2),
          rate: sig(q.rate),
          roundedTo: QUOTE_SIG_FIGS,
        };
      },
    );
  };
}
