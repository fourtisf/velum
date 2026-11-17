'use client';
/**
 * Referral links: a visitor who arrives with ?ref=<code> keeps the code in this browser (first visit wins, 30 days);
 * when a wallet connects, the API records once that this wallet came through that code (not the wallet's own). Codes
 * are a wallet's first 10 hex digits (@velum/config/src/alerts refCode). Counts only: no reward is promised.
 */
import { REF_CODE_RE } from '@velum/config/src/alerts';
import { ENV } from './env';

const KEY = 'velum.ref';
const SENT = (addr: string) => `velum.ref.sent.${addr.toLowerCase()}`;
const TTL = 30 * 86_400_000;

function get(k: string): string | null {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
}
function put(k: string, v: string) {
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* no storage */
  }
}

/** Keeps ?ref=<code> from the current URL (first visit wins while it is fresh). */
export function captureRef(search: string = typeof window !== 'undefined' ? window.location.search : '', now = Date.now()) {
  const code = new URLSearchParams(search).get('ref')?.toLowerCase() ?? '';
  if (!REF_CODE_RE.test(code)) return;
  const have = get(KEY);
  if (have) {
    try {
      const v = JSON.parse(have) as { at?: number };
      if (typeof v.at === 'number' && now - v.at < TTL) return;
    } catch {
      /* replace a malformed value */
    }
  }
  put(KEY, JSON.stringify({ code, at: now }));
}

/** The stored referral code, if fresh. */
export function storedRef(now = Date.now()): string | null {
  const have = get(KEY);
  if (!have) return null;
  try {
    const v = JSON.parse(have) as { code?: string; at?: number };
    return typeof v.code === 'string' && REF_CODE_RE.test(v.code) && typeof v.at === 'number' && now - v.at < TTL ? v.code : null;
  } catch {
    return null;
  }
}

/** Tells the API, once per wallet, which code this wallet arrived with. */
export function attributeRef(address: string) {
  const code = storedRef();
  if (!code || get(SENT(address))) return;
  put(SENT(address), '1');
  void fetch(`${ENV.apiUrl}/v1/referrals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, code }) }).catch(() => undefined);
}
