/**
 * A real (Phase 3) flow: what the dialog shows for review before the first wallet prompt (exact amounts,
 * fees, liquidation price, price limits), then one step per transaction with real states, then a receipt
 * with every transaction hash. The same dialog shape as the prototype's simulated flows (step list and
 * receipt), built by lib/onchain/flows.tsx and run by components/modals/TxFlow.tsx.
 */
import type { ReactNode } from 'react';
import type { Address, Hash, TransactionReceipt } from 'viem';
import type { Deployment } from './deployment';
import type { Protocol } from './reads';
import type { TxCall } from './tx';

export type Row = [ReactNode, ReactNode];

export interface TxRunCtx {
  d: Deployment;
  proto: Protocol;
  account: Address;
  /** Values a step passes to later steps and to the receipt (e.g. the amount a swap returned). */
  out: Record<string, unknown>;
  /** Confirmed transactions, in order. */
  txs: Array<{ label: string; hash: Hash }>;
}

export interface TxStepSpec {
  /** Step title, e.g. "Approve 100 USDG". */
  t: string;
  /** What the step does, shown under the title until the transaction is under way. */
  d?: string;
  /** Short name of its transaction on the receipt, e.g. "Deposit". */
  label: string;
  /** The call to send, built when the step runs (after earlier steps); null skips it (already done). */
  call: (ctx: TxRunCtx) => Promise<TxCall | null> | TxCall | null;
  /** Re-simulate while it reverts with one of these errors (a fresh oracle price is about to land). */
  waitFor?: readonly string[];
  /** Reads the confirmed receipt (decoded events) into ctx.out. */
  after?: (r: TransactionReceipt, ctx: TxRunCtx) => void;
  /** Token a swap or removal pays out, to word a Slippage revert. */
  outToken?: string;
}

export interface TxFlowSpec {
  title: string;
  /** Exact amounts shown before anything is signed. */
  review: Row[];
  /** A note under the review (what becomes public, fees, risks). */
  note?: string;
  confirmLabel?: string;
  steps: TxStepSpec[];
  /** The receipt and toast once every step is confirmed. */
  done: (ctx: TxRunCtx) => { rows: Row[]; toast: string };
  d: Deployment;
  proto: Protocol;
  account: Address;
}
