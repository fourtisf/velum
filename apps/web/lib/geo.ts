'use client';
/**
 * Where perps may be offered to this visitor (the API's GET /v1/geo, apps/api/src/routes/geo.ts), and the perps statement
 * each wallet accepts once per version of the terms (lib/legal.ts LEGAL_VERSION), kept in this browser only.
 */
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { ENV } from './env';
import { LEGAL_VERSION } from './legal';

export type PerpsGeo = 'allowed' | 'blocked' | 'unknown';

/** The visitor's perps status, once per session ("unknown" while loading or when the API cannot tell). */
export function usePerpsGeo(): PerpsGeo {
  const q = useQuery({
    queryKey: ['geo'],
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
    queryFn: async ({ signal }) => {
      const r = await fetch(`${ENV.apiUrl}/v1/geo`, { signal, headers: { accept: 'application/json' }, cache: 'no-store' });
      const j = (await r.json()) as { perps?: unknown };
      return j.perps === 'blocked' || j.perps === 'allowed' ? j.perps : 'unknown';
    },
  });
  return q.data ?? 'unknown';
}

const key = (addr: string) => `velum.perpsTerms.${LEGAL_VERSION}.${addr.toLowerCase()}`;
function read(addr: string): boolean {
  try {
    return !!window.localStorage.getItem(key(addr));
  } catch {
    return false;
  }
}

interface TermsState {
  accepted: Record<string, boolean>;
  isAccepted: (addr: string) => boolean;
  accept: (addr: string) => void;
}

/** Whether a wallet accepted the current perps statement in this browser. */
export const usePerpsTerms = create<TermsState>((set, get) => ({
  accepted: {},
  isAccepted: (addr) => {
    const a = addr.toLowerCase();
    if (a in get().accepted) return get().accepted[a]!;
    return typeof window !== 'undefined' && read(a);
  },
  accept: (addr) => {
    const a = addr.toLowerCase();
    try {
      window.localStorage.setItem(key(a), String(Date.now()));
    } catch {
      /* private mode: accepted for this session only */
    }
    set((s) => ({ accepted: { ...s.accepted, [a]: true } }));
  },
}));
