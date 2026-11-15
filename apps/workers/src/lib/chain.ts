import type { Logger } from './log';
import { redact } from './redact';
import { sleep } from './retry';

/** eth_chainId of an RPC endpoint, or throws (unreachable, HTTP error, malformed answer). */
export async function rpcChainId(rpcUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<number> {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown };
  if (typeof body.result !== 'string' || !/^0x[0-9a-f]{1,16}$/i.test(body.result)) throw new Error('malformed eth_chainId answer');
  return Number.parseInt(body.result, 16);
}

export type ChainCheck = 'unknown' | 'ok' | 'mismatch';

/**
 * Checks once, in the background, that RPC_URL serves the configured chain (audit I-5), retrying every
 * `retryMs` while the RPC is unreachable; it never stops the process. A mismatch is logged as an error
 * and reported by state() (the Chainlink source refuses to read then). In Phase 2 the workers read no
 * chain data with the demo or robinhood source, so this only warns.
 */
export function startChainCheck(rpcUrl: string, expected: number, log: Logger, opts: { fetchImpl?: typeof fetch; retryMs?: number; signal?: AbortSignal } = {}) {
  let state: ChainCheck = 'unknown';
  const { fetchImpl = fetch, retryMs = 60_000, signal } = opts;
  const done = (async () => {
    while (!signal?.aborted) {
      try {
        const got = await rpcChainId(rpcUrl, fetchImpl);
        state = got === expected ? 'ok' : 'mismatch';
        if (state === 'mismatch') log.error('RPC_URL serves another chain', { expected, got });
        return;
      } catch (err) {
        log.warn('RPC unreachable; chain id not verified yet', { err: redact(err instanceof Error ? err.message : String(err)) });
        await sleep(retryMs, signal).catch(() => undefined);
      }
    }
  })();
  return { state: () => state, done };
}
