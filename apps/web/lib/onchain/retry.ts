/**
 * Never twice (web audit W3-01): the rule for sending a flow step again once its wallet request was made.
 * Pure, so tests cover every case; components/modals/TxFlow.tsx applies it.
 *
 * "Cancel" in the dialog cannot withdraw a request the wallet is showing, so the request stays tracked: a
 * hash that arrives afterwards is followed to its receipt. A step that reached the signature may be sent
 * again only once its wallet request settled without a hash and the account's pending nonce has not moved
 * since it was recorded (right before the wallet was asked). Anything else may already be pending.
 */

/** What is known about a step once its wallet request was made. */
export interface SignRecord {
  /** Pending nonce read right before the wallet was asked (null: unreadable). */
  nonce: number | null;
  /** The wallet returned a hash (possibly after Cancel). */
  hash?: `0x${string}`;
  /** The wallet request and its receipt are settled (resolved or failed). */
  settled: boolean;
  /** The user pressed Cancel while it was open. */
  cancelled: boolean;
}

export type RetryVerdict = 'ok' | 'open' | 'sent' | 'pending' | 'unknown';

/**
 * ok: send again. open: the wallet request is still open. sent: a hash is known. pending: the nonce moved (a
 * transaction went out since). unknown: the nonce could not be read, so a pending transaction cannot be ruled out.
 */
export function retryVerdict(rec: SignRecord, nonceNow: number | null): RetryVerdict {
  if (!rec.settled) return 'open';
  if (rec.hash) return 'sent';
  if (rec.nonce === null || nonceNow === null) return 'unknown';
  return nonceNow > rec.nonce ? 'pending' : 'ok';
}

/** The sentences of the rule. */
export const RETRY_COPY = {
  cancelledOpen:
    'Cancelled here, but your wallet may still show the request: a transaction may already be pending. Check your wallet and your activity. If your wallet sends it, this dialog follows it.',
  stillOpen: 'Your wallet still has this request open, so it cannot be asked again. Approve or reject it in your wallet; this dialog follows what happens.',
  pending:
    'A transaction may already be pending: your wallet has sent a transaction since this step asked for a signature. Check your wallet and your activity before doing this again.',
  unknownNonce: 'A transaction may already be pending, and your wallet’s transaction count could not be read to rule it out. Check your wallet and your activity before doing this again.',
  sent: 'This step was already sent and cannot be sent twice. Check your wallet and your activity.',
  sentLate: 'Your wallet sent this transaction after you pressed Cancel. Waiting for its confirmation…',
  declinedLate: 'Your wallet declined the request after you pressed Cancel. Nothing was sent.',
  resume: 'Your wallet sent this step after you pressed Cancel, and it is confirmed. Continue with the remaining steps, or close.',
} as const;

/** The sentence for a refused retry. */
export function refusedRetry(v: Exclude<RetryVerdict, 'ok'>): string {
  return v === 'open' ? RETRY_COPY.stillOpen : v === 'pending' ? RETRY_COPY.pending : v === 'sent' ? RETRY_COPY.sent : RETRY_COPY.unknownNonce;
}
