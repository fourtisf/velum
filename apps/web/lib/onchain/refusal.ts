/** When a transaction may be sent (pure, so tests cover every case; lib/onchain/tx.ts applies it). */
import { ONCHAIN_MAINNET_CHAIN_ID } from '@velum/config/src/onchain';

export type Refusal = 'not-connected' | 'account-changed' | 'wrong-chain' | 'deployment';

/**
 * Why nothing may be sent right now, or null. Pure (unit-tested). A transaction goes out only when the
 * wallet's chain, the deployment's chain and this app's chain are the same, so nothing is ever sent on
 * Robinhood Chain mainnet (4663) unless the deployment compiled into this build is for 4663.
 */
export function sendRefusal(p: { walletChainId: number | undefined; walletAddress: string | undefined; account: string; deploymentChainId: number; appChainId: number }): Refusal | null {
  if (!p.walletAddress) return 'not-connected';
  if (p.walletAddress.toLowerCase() !== p.account.toLowerCase()) return 'account-changed';
  if (p.deploymentChainId !== p.appChainId) return 'deployment';
  if (p.appChainId === ONCHAIN_MAINNET_CHAIN_ID && p.deploymentChainId !== ONCHAIN_MAINNET_CHAIN_ID) return 'deployment';
  if (p.walletChainId !== p.deploymentChainId) return 'wrong-chain';
  return null;
}

