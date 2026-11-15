'use client';
/**
 * Sends one contract call the safe way: the wallet must be connected to the deployment's chain (never a
 * guess, never mainnet unless the compiled deployment is for mainnet), the call is simulated against the
 * chain first (viem simulateContract, so a revert is shown before the wallet is asked), then the wallet
 * signs, and the receipt is awaited. Each stage is reported so the flow dialog shows real states:
 * checking, waiting for a fresh price, signature requested, submitted (hash), confirmed or failed.
 */
import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hash, type TransactionReceipt } from 'viem';
import { getConnection, switchChain, writeContract } from 'wagmi/actions';
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function checkSendable(d: Deployment, account: Address): void {
  const c = getConnection(wagmiConfig);
  const r = sendRefusal({ walletChainId: c.chainId, walletAddress: c.status === 'connected' ? c.address : undefined, account, deploymentChainId: d.chainId, appChainId: ENV.chainId });
  if (r) throw new SendRefused(r);
}

/** Asks the wallet to switch to the deployment's chain. */
export async function switchToDeployment(d: Deployment): Promise<void> {
  await switchChain(wagmiConfig, { chainId: d.chainId as typeof ENV.chainId });
}

export interface SendOptions {
  /** Keep re-simulating while it reverts with one of these (a fresh price is about to land), up to `waitMs`. */
  waitFor?: readonly string[];
  waitMs?: number;
  onStage: (s: TxStage, hash?: Hash) => void;
  /** Checked between stages: false once the user cancelled (the result is then ignored). */
  live: () => boolean;
}

export async function sendTx(d: Deployment, account: Address, call: TxCall, o: SendOptions): Promise<{ hash: Hash; receipt: TransactionReceipt }> {
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
  // The wallet could have switched account or network while we simulated.
  checkSendable(d, account);
  o.onStage('sign');
  const hash = await writeContract(wagmiConfig, { ...(request as object), account, chainId: d.chainId } as Parameters<typeof writeContract>[1]);
  o.onStage('submitted', hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success') {
    // Mined but reverted (state changed between the simulation and inclusion): replay it on the block before
    // to recover the contract's reason.
    let reason: unknown = new Error('The transaction reverted onchain.');
    try {
      await publicClient.simulateContract({ account, address: call.address, abi: call.abi, functionName: call.functionName, args: call.args, value: call.value, blockNumber: receipt.blockNumber - 1n } as Parameters<typeof publicClient.simulateContract>[0]);
    } catch (e) {
      reason = e;
    }
    throw new TxReverted(hash, reason);
  }
  o.onStage('confirmed', hash);
  return { hash, receipt };
}

/** Explorer link for a transaction, or null on a local development chain without an explorer. */
export function txUrl(hash: string): string | null {
  if (ENV.localRpc && !process.env.NEXT_PUBLIC_EXPLORER_URL) return null;
  return `${ENV.explorerUrl}/tx/${hash}`;
}
