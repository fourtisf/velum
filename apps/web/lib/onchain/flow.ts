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
  /**
   * Safe to send again after an unclear outcome: `call` re-reads the chain and returns null once it is done
   * (approvals). Every other step can never be retried blindly once the wallet was asked to sign it (web audit
   * W3-01): the dialog first checks the account's pending nonce and any hash that arrived late.
   */
  idempotent?: boolean;
  /** Re-simulate while it reverts with one of these errors (a fresh oracle price is about to land). */
  waitFor?: readonly string[];
  /**
   * Reads the confirmed receipt into ctx.out, from the expected events of the expected contract only (web
   * audit W3-04): throws ReceiptMismatch when they are not there, so a receipt never shows what did not happen.
   */
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
  /** A statement the user must tick before the wallet is asked (e.g. a high close spread, web audit W3-03). */
  ack?: string;
  steps: TxStepSpec[];
  /** The receipt and toast once every step is confirmed. */
  done: (ctx: TxRunCtx) => { rows: Row[]; toast: string };
  d: Deployment;
  proto: Protocol;
  account: Address;
}

/** A confirmed transaction whose receipt lacks the events the step expects from its contract (web audit W3-04). */
export class ReceiptMismatch extends Error {
  constructor(public what: string) {
    super(`missing ${what}`);
  }
}
