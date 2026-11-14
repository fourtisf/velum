/**
 * RPC endpoints (audit web L12).
 *
 * Wallets only ever get the official public RPC (it is the chain definition passed to
 * wallet_addEthereumChain). A custom NEXT_PUBLIC_RPC_URL often embeds a provider API key, so it is
 * used for this app's own reads only, and only if it uses https (plain http is allowed for a
 * loopback dev node) and answers eth_chainId with the configured chain. The check runs once, at
 * startup in the browser; until it settles, reads wait for it; on a mismatch, error or timeout
 * every read goes to the official RPC and a warning is logged (host only, never the full URL).
 */
import { CHAIN } from '@velum/config';
import { createTransport, http, type EIP1193RequestFn, type Transport } from 'viem';
import { safeUrl, warn } from './env';

const browser = typeof window !== 'undefined';

/** The official public RPC: the only one wallets are given. */
export const OFFICIAL_RPC = CHAIN.rpcUrl;

const customUrl = safeUrl(process.env.NEXT_PUBLIC_RPC_URL, 'NEXT_PUBLIC_RPC_URL');
/** Custom read RPC, if configured and well formed (still subject to the chain check). */
export const CUSTOM_RPC: string | null = customUrl && customUrl.href.replace(/\/$/, '') !== OFFICIAL_RPC.replace(/\/$/, '') ? customUrl.href : null;
const customHost = customUrl?.host ?? '';

let verdict: Promise<boolean> | null = null;

async function checkChain(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      cache: 'no-store',
      credentials: 'omit',
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
    const hex = typeof body?.result === 'string' && /^0x[0-9a-f]{1,16}$/i.test(body.result) ? body.result : null;
    const id = hex ? Number.parseInt(hex, 16) : NaN;
    if (id === CHAIN.id) return true;
    warn(`Custom RPC ${customHost} reports chain ${Number.isNaN(id) ? 'unknown' : id}, not ${CHAIN.label} (${CHAIN.id}). Using the official RPC.`);
    return false;
  } catch {
    warn(`Custom RPC ${customHost} did not answer eth_chainId. Using the official RPC.`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves true when reads may use the custom RPC. Runs the check at most once per page load. */
export function customRpcOk(): Promise<boolean> {
  if (!CUSTOM_RPC || !browser) return Promise.resolve(false);
  return (verdict ??= checkChain(CUSTOM_RPC));
}

// Start the check as soon as the app loads, so the first balance read rarely waits.
void customRpcOk();

/**
 * Transport for this app's reads (balances, multicall). Reports no URL of its own, so wagmi
 * connectors that look one up (WalletConnect's rpcMap) fall back to the chain's official RPC.
 */
export function readTransport(): Transport {
  const official = http(OFFICIAL_RPC, { batch: true, retryCount: 2 });
  const custom = CUSTOM_RPC;
  if (!custom) return official;
  const viaCustom = http(custom, { batch: true, retryCount: 2 });
  return (params) => {
    const o = official(params);
    const c = viaCustom(params);
    // Each inner transport retries on its own; this one only picks which to call.
    const request = (async (args, options) => ((await customRpcOk()) ? c : o).request(args, options)) as EIP1193RequestFn;
    return createTransport({ key: 'velumRead', name: 'Velum read RPC', type: 'velumRead', retryCount: 0, request });
  };
}
