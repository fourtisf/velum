import { BaseError, ContractFunctionRevertedError } from 'viem';
import { redact } from '../lib/redact';

/**
 * A short, redacted description of an RPC or contract error for logs and the health status: the custom
 * error name and arguments when the revert was decoded (e.g. "PriceLagging(0x…)"), otherwise viem's short
 * message. Never more than 300 characters.
 */
export function describeError(err: unknown): string {
  let out: string;
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
      const args = (reverted.data.args ?? []).map((a) => (typeof a === 'bigint' ? a.toString() : String(a)));
      out = `${reverted.data.errorName}(${args.join(', ')})`;
    } else {
      out = err.shortMessage || err.message;
    }
  } else {
    out = err instanceof Error ? err.message : String(err);
  }
  return redact(out.split('\n')[0] ?? '').slice(0, 300);
}

/** The full lower-cased message chain of an error, for matching node error texts ("nonce too low", ...). */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; e && i < 8; i++) {
    if (e instanceof Error) {
      parts.push(e.message);
      const details = (e as { details?: unknown }).details;
      if (typeof details === 'string') parts.push(details);
      e = (e as { cause?: unknown }).cause;
    } else {
      parts.push(String(e));
      break;
    }
  }
  return parts.join(' | ').toLowerCase();
}

/**
 * A warning logger that repeats the same message at most once per `everyMs` (an RPC outage must not write a
 * line per tick), counting what it held back.
 */
export function throttledWarn(log: { warn(msg: string, data?: Record<string, unknown>): void }, everyMs = 60_000, now: () => number = Date.now) {
  const last = new Map<string, { at: number; held: number }>();
  return (msg: string, data: Record<string, unknown> = {}): void => {
    const t = now();
    const prev = last.get(msg);
    if (prev && t - prev.at < everyMs) {
      prev.held++;
      return;
    }
    last.set(msg, { at: t, held: 0 });
    log.warn(msg, prev?.held ? { ...data, repeated: prev.held } : data);
  };
}

/** The error name of a decoded contract revert, or null. */
export function revertName(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? null) : null;
}
