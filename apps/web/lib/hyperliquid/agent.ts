/**
 * The browser-held agent ("API wallet") that signs Hyperliquid orders for one user (CLAUDE.md §1.6: keys live only in
 * the browser). Generated here, approved once by the user's own wallet (approveAgent, an EIP-712 signature, no gas),
 * stored in this browser only, never sent to Velum. An agent can trade but cannot withdraw or transfer funds out of
 * the account (Hyperliquid: withdrawals and transfers to others are user-signed actions).
 *
 * Named "velum" with a 30-day expiry (agentName "velum valid_until <ms>", Hyperliquid allows up to 180 days); approving
 * a new one with the same name replaces the old one, so agents never pile up. Following Hyperliquid's advice, a fresh
 * key is generated for every approval and never reused.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export const AGENT_NAME = 'velum';
export const AGENT_DAYS = 30;
/** An agent expiring sooner than this is renewed before trading. */
const RENEW_BEFORE_MS = 86_400_000;
const KEY_RE = /^0x[0-9a-f]{64}$/;
const ADDR_RE = /^0x[0-9a-f]{40}$/;

export interface StoredAgent {
  user: `0x${string}`;
  address: `0x${string}`;
  pk: `0x${string}`;
  validUntil: number;
}

const storageKey = (user: string) => `velum:hl-agent:${user.toLowerCase()}`;

function store(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The agent stored for `user`, or null when there is none, it is malformed, or it expires within a day. */
export function loadAgent(user: string, now = Date.now(), s: Storage | null = store()): StoredAgent | null {
  let raw: string | null = null;
  try {
    raw = s?.getItem(storageKey(user)) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredAgent>;
    if (typeof v.pk !== 'string' || !KEY_RE.test(v.pk) || typeof v.address !== 'string' || !ADDR_RE.test(v.address)) return null;
    if (v.user !== user.toLowerCase() || typeof v.validUntil !== 'number' || v.validUntil - now < RENEW_BEFORE_MS) return null;
    // The stored address must be the key's own (a tampered entry is ignored).
    if (privateKeyToAccount(v.pk as `0x${string}`).address.toLowerCase() !== v.address) return null;
    return v as StoredAgent;
  } catch {
    return null;
  }
}

/** A new agent for `user` (not stored until its approval succeeded: saveAgent). */
export function newAgent(user: string, now = Date.now()): StoredAgent & { name: string } {
  const pk = generatePrivateKey();
  const validUntil = now + AGENT_DAYS * 86_400_000;
  return { user: user.toLowerCase() as `0x${string}`, address: privateKeyToAccount(pk).address.toLowerCase() as `0x${string}`, pk, validUntil, name: `${AGENT_NAME} valid_until ${validUntil}` };
}

export function saveAgent(a: StoredAgent, s: Storage | null = store()): void {
  try {
    s?.setItem(storageKey(a.user), JSON.stringify({ user: a.user, address: a.address, pk: a.pk, validUntil: a.validUntil }));
  } catch {
    /* private mode: trading still works for this page, the next visit asks again */
  }
}

export function clearAgent(user: string, s: Storage | null = store()): void {
  try {
    s?.removeItem(storageKey(user));
  } catch {
    /* nothing stored */
  }
}

/** Whether Hyperliquid still lists `agent` as an approved agent of the user (extraAgents info, lower-case compare). */
export function agentListed(agents: unknown, agent: string): boolean {
  return Array.isArray(agents) && agents.some((a) => a && typeof a === 'object' && typeof (a as { address?: unknown }).address === 'string' && (a as { address: string }).address.toLowerCase() === agent.toLowerCase());
}
