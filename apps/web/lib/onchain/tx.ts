'use client';
/**
 * Sends one contract call the safe way: the wallet must be connected to the target's chain (never a guess, never
 * mainnet unless the target is on mainnet: the guarded deployment, or the curated Uniswap venue for spot), the call is simulated against the
 * chain first (viem simulateContract, so a revert is shown before the wallet is asked), the account's pending
 * nonce is recorded, then the wallet signs, and the receipt is awaited. Each stage is reported so the flow
 * dialog shows real states: checking, waiting for a fresh price, signature requested, submitted (hash),
 * confirmed or failed.
 *
 * A transaction the wallet replaced is never reported as confirmed (web audit W3-04): a cancellation or a
 * different transaction in its nonce slot fails the step; a repriced one (same call, new fee) is followed
 * under its new hash. The receipt must come from the account and be addressed to the called contract.
 */
import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hash, type ReplacementReason, type TransactionReceipt } from 'viem';
import { getConnection, getConnectorClient, switchChain, writeContract } from 'wagmi/actions';
import { publicClient } from '../chain';
import { ENV } from '../env';
import { wagmiConfig } from '../wagmi';
import type { Deployment } from './deployment';
import { sendRefusal, type Refusal } from './refusal';

export interface TxCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

export type TxStage = 'checking' | 'waiting' | 'sign' | 'submitted' | 'confirmed';

export { sendRefusal, type Refusal } from './refusal';

export class SendRefused extends Error {
  constructor(public reason: Refusal) {
    super(reason);
  }
}

/** The error name of a reverted simulation, if any. */
export function revertName(e: unknown): string | null {
  if (!(e instanceof BaseError)) return null;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  return r?.data?.errorName ?? null;
}

export class TxReverted extends Error {
  constructor(
    public hash: Hash,
    public reason: unknown,
  ) {
    super('reverted');
  }
}

/**
 * The wallet put another transaction in this one's nonce slot (a cancel or a different call): what was
 * asked did not happen. `replacement` is the hash that took the slot.
 */
export class TxReplaced extends Error {
  constructor(
    public hash: Hash,
    public reason: Exclude<ReplacementReason, 'repriced'>,
    public replacement: Hash,
  ) {
    super(reason);
  }
}

/** A confirmed receipt that is not the call that was sent (another sender or another contract). */
export class TxUnexpected extends Error {
  constructor(public hash: Hash) {
    super('unexpected receipt');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function checkSendable(d: Pick<Deployment, 'chainId'>, account: Address): void {
  const c = getConnection(wagmiConfig);
  const r = sendRefusal({ walletChainId: c.chainId, walletAddress: c.status === 'connected' ? c.address : undefined, account, deploymentChainId: d.chainId, appChainId: ENV.chainId });
  if (r) throw new SendRefused(r);
}

/** Asks the wallet to switch to the deployment's chain. */
export async function switchToDeployment(d: Pick<Deployment, 'chainId'>): Promise<void> {
  await switchChain(wagmiConfig, { chainId: d.chainId as typeof ENV.chainId });
}

const nonceOf = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^0x[0-9a-f]{1,14}$/i.test(v)) return Number.parseInt(v, 16);
  return null;
};

/**
 * The account's pending nonce: the higher of what the app's read RPC and the wallet's own provider report
 * (the wallet may know a transaction the read RPC has not seen yet). Null when neither answers.
 */
export async function pendingNonce(account: Address): Promise<number | null> {
  const [fromRpc, fromWallet] = await Promise.all([
    publicClient.getTransactionCount({ address: account, blockTag: 'pending' }).then(nonceOf, () => null),
    getConnectorClient(wagmiConfig)
      .then((c) => c.request({ method: 'eth_getTransactionCount', params: [account, 'pending'] }))
      .then(nonceOf, () => null),
  ]);
  if (fromRpc === null) return fromWallet;
  return fromWallet === null ? fromRpc : Math.max(fromRpc, fromWallet);
}

export interface SendOptions {
  /** Keep re-simulating while it reverts with one of these (a fresh price is about to land), up to `waitMs`. */
  waitFor?: readonly string[];
  waitMs?: number;
  onStage: (s: TxStage, hash?: Hash) => void;
  /** Right before the wallet is asked to sign: the account's pending nonce then (null if unreadable). */
  onSign?: (nonce: number | null) => void;
  /** Checked between stages: false once the user cancelled. Nothing is asked of the wallet after that. */
  live: () => boolean;
}

export async function sendTx(d: Pick<Deployment, 'chainId'>, account: Address, call: TxCall, o: SendOptions): Promise<{ hash: Hash; receipt: TransactionReceipt }> {
  checkSendable(d, account);
  o.onStage('checking');
  const until = Date.now() + (o.waitMs ?? 45_000);
  let request: unknown;
  for (;;) {
    try {
      const sim = await publicClient.simulateContract({ account, address: call.address, abi: call.abi, functionName: call.functionName, args: call.args, value: call.value } as Parameters<typeof publicClient.simulateContract>[0]);
      request = sim.request;
      break;
    } catch (e) {
      const name = revertName(e);
      if (!name || !o.waitFor?.includes(name) || Date.now() > until || !o.live()) throw e;
      o.onStage('waiting');
      await sleep(1500);
      if (!o.live()) throw new Error('cancelled');
    }
  }
  if (!o.live()) throw new Error('cancelled');
  const nonce = await pendingNonce(account);
  if (!o.live()) throw new Error('cancelled');
  // The wallet could have switched account or network while we simulated.
  checkSendable(d, account);
  o.onSign?.(nonce);
  o.onStage('sign');
  const hash = await writeContract(wagmiConfig, { ...(request as object), account, chainId: d.chainId } as Parameters<typeof writeContract>[1]);
  o.onStage('submitted', hash);
  let replaced: { reason: ReplacementReason; hash: Hash } | null = null;
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 180_000,
    onReplaced: (r) => {
      replaced = { reason: r.reason, hash: r.transaction.hash };
    },
  });
  const rep = replaced as { reason: ReplacementReason; hash: Hash } | null;
  if (rep && rep.reason !== 'repriced') throw new TxReplaced(hash, rep.reason, rep.hash);
  // Repriced: the same call under a new hash; follow that one from here on.
  const final = receipt.transactionHash;
  if (receipt.from.toLowerCase() !== account.toLowerCase() || receipt.to?.toLowerCase() !== call.address.toLowerCase()) throw new TxUnexpected(final);
  if (receipt.status !== 'success') {
    // Mined but reverted (state changed between the simulation and inclusion): replay it on the block before
    // to recover the contract's reason.
    let reason: unknown = new Error('The transaction reverted onchain.');
    try {
      await publicClient.simulateContract({ account, address: call.address, abi: call.abi, functionName: call.functionName, args: call.args, value: call.value, blockNumber: receipt.blockNumber - 1n } as Parameters<typeof publicClient.simulateContract>[0]);
    } catch (e) {
      reason = e;
    }
    throw new TxReverted(final, reason);
  }
  if (final !== hash) o.onStage('submitted', final);
  o.onStage('confirmed', final);
  return { hash: final, receipt };
}

/** Explorer link for a transaction, or null on a local development chain without an explorer. */
export function txUrl(hash: string): string | null {
  if (ENV.localRpc && !process.env.NEXT_PUBLIC_EXPLORER_URL) return null;
  return `${ENV.explorerUrl}/tx/${hash}`;
}
