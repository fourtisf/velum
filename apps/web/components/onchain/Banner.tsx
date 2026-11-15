'use client';
import type { OnchainInfo } from '@/lib/onchain/deployment';
import { GUARD_COPY } from '@/lib/onchain/guard';
import { useGuard } from '@/lib/onchain/reads';
import { useApp } from '@/lib/store';

/** "Guarded beta" in the top bar while the vault's launch guard is active. */
export function GuardBannerBadge({ oc }: { oc: OnchainInfo }) {
  const addr = useApp((s) => s.account?.addr);
  const g = useGuard(oc, addr).data;
  if (!g?.guarded) return null;
  return <span className="badge hide-sm">{GUARD_COPY.badge}</span>;
}
