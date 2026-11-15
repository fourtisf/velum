/**
 * The launch guard (VelumVault allowlist and deposit caps) as the UI applies it: who may deposit and open
 * new trades, and how much may still be deposited. Pure, so tests cover every case. Withdrawals, closes,
 * margin additions to existing positions by a listed account, offer withdrawals and liquidity removal are
 * never blocked by the guard (contracts/README.md, Guarded launch); this module never gates them.
 */
import type { GuardState } from './reads';

export const MAX_UINT256 = 2n ** 256n - 1n;

export interface GuardView {
  /** Show the "Guarded beta" badge. */
  guarded: boolean;
  /** The allowlist is active and this wallet is not on it: no deposits, no new approvals, so no new trades. */
  blocked: boolean;
  /** "Allowlisted", "Not allowlisted" or null when there is no allowlist (or no account). */
  status: 'allowlisted' | 'not-allowlisted' | null;
  /** Remaining deposit limit by symbol while caps are active (null when uncapped). */
  limits: Record<string, bigint> | null;
}

export function guardView(g: GuardState | undefined | null, connected: boolean): GuardView {
  if (!g) return { guarded: false, blocked: false, status: null, limits: null };
  const listed = !g.allowlistActive || g.allowlisted;
  return {
    guarded: g.guarded,
    blocked: connected && !listed,
    status: !g.allowlistActive || !connected ? null : g.allowlisted ? 'allowlisted' : 'not-allowlisted',
    limits: g.capsActive && connected ? g.depositLimit : null,
  };
}

/** Why a deposit of `units` of `sym` would be refused by the guard, or null. */
export function depositRefusal(v: GuardView, sym: string, units: bigint): 'not-allowlisted' | 'over-limit' | null {
  if (v.blocked) return 'not-allowlisted';
  const left = v.limits?.[sym];
  if (left !== undefined && left !== MAX_UINT256 && units > left) return 'over-limit';
  return null;
}

export const GUARD_COPY = {
  badge: 'Guarded beta',
  blocked: 'This wallet is not on the guarded beta allowlist, so it cannot deposit or open new trades. Withdrawals and closes always work.',
  blockedShort: 'Not on the beta allowlist',
  allowlisted: 'Allowlisted',
  notAllowlisted: 'Not allowlisted',
  overLimit: 'Above your remaining guarded beta deposit limit.',
} as const;
