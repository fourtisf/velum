'use client';
import type { Address } from 'viem';
import type { OnchainInfo } from '@/lib/onchain/deployment';
import type { FlowBase } from '@/lib/onchain/flows';
import { guardView, type GuardView } from '@/lib/onchain/guard';
import { useAccountState, useGuard, useProtocol, type AccountState, type Protocol } from '@/lib/onchain/reads';
import { unitsToWad } from '@/lib/onchain/units';
import { useApp } from '@/lib/store';

export interface OcContext {
  oc: OnchainInfo;
  /** The signed-in wallet (the app's account), or undefined. */
  addr: Address | undefined;
  proto: Protocol | undefined;
  acct: AccountState | undefined;
  guard: GuardView;
  /** Everything a flow builder needs, once loaded and signed in. */
  base: FlowBase | null;
  /** Decimals of a symbol (USDG 6, stocks 18 from chain), or undefined while loading. */
  dec: (sym: string) => number | undefined;
  /** Free vault balance of a symbol as a Wad (0 while loading). */
  vaultWad: (sym: string) => bigint;
}

/** The real-mode state every on-chain view needs, from shared react-query caches. */
export function useOc(oc: OnchainInfo): OcContext {
  const account = useApp((s) => s.account);
  const addr = account?.addr;
  const proto = useProtocol(oc).data;
  const acct = useAccountState(oc, addr).data;
  const g = useGuard(oc, addr).data;
  const dec = (sym: string) => proto?.decimals[sym];
  return {
    oc,
    addr,
    proto,
    acct,
    guard: guardView(g, !!addr),
    base: proto && addr ? { oc, proto, account: addr } : null,
    dec,
    vaultWad: (sym) => {
      const d = dec(sym);
      return d === undefined || !acct ? 0n : unitsToWad(acct.vault[sym] ?? 0n, d);
    },
  };
}

export type { GuardView };
