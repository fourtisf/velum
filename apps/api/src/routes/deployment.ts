import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';
import { ApiError, notFound } from '../lib/errors';
import { checksum } from '../lib/onchain';

export const NOT_DEPLOYED = 'No Velum contracts are deployed on this network yet.';

/**
 * GET /v1/deployment (Phase 3): the chain id, start block, contract and token addresses (checksummed) from
 * contracts/deployments/<CHAIN_ID>.json, the guard state the contracts expose (the optional guardian and each
 * market's close-only flag, from the indexed CloseOnlySet events) and the indexer's progress. 404 until a
 * deployment file exists for the configured chain.
 */
export function deploymentRoutes(deps: AppDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  return async (app) => {
    app.get('/v1/deployment', async () => {
      const d = deps.deployment?.get() ?? null;
      if (!d) throw notFound(NOT_DEPLOYED);
      let closeOnly: Record<string, boolean> | null = null;
      if (deps.onchain) {
        try {
          const flags = await deps.onchain.closeOnly(d);
          closeOnly = Object.fromEntries(Object.entries(d.tokens).filter(([s]) => s !== 'USDG').map(([s, a]) => [s, flags[a] ?? false]));
        } catch {
          throw new ApiError(503, 'UNAVAILABLE', 'The index is temporarily unavailable. Try again in a moment.');
        }
      }
      const status = deps.cache.onchainStatus ? await deps.cache.onchainStatus().catch(() => null) : null;
      const fresh = status && status.chainId === d.chainId && status.deployment === d.contracts.perpsMarkets;
      return {
        chainId: d.chainId,
        startBlock: d.startBlock,
        contracts: Object.fromEntries(Object.entries(d.contracts).map(([k, v]) => [k, checksum(v)])),
        tokens: Object.fromEntries(Object.entries(d.tokens).map(([k, v]) => [k, checksum(v)])),
        priceRelayer: checksum(d.priceRelayer),
        guard: { guardian: checksum(d.guardian), closeOnly },
        indexer: fresh ? { block: status.indexer.block, lag: status.indexer.lagBlocks, age: Math.max(0, Math.round((now() - status.at) / 1000)) } : null,
      };
    });
  };
}
