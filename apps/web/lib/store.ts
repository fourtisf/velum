'use client';
/**
 * App state, mirroring the prototype's `S` object. Private balances, positions and history
 * are a browser-only demo ledger (Phase 2), persisted per wallet in localStorage.
 * Nothing here is sent to a server.
 */
import { CHAIN, DEFAULT_SYMBOL, IS_MAINNET, PROTOCOL, type Timeframe } from '@velum/config';
import { parseWad, type Side, type SpotSide, type Wad } from '@velum/math';
import type { ReactNode } from 'react';
import { create } from 'zustand';
import type { IconName } from '@/components/icons';
import { randomHex } from './format';
import { decodeLedger, encodeLedger } from './ledger-codec';

export { OFFER_EXPIRIES } from './ledger-codec';

export interface Position {
  id: string;
  sym: string;
  side: Side;
  lev: number;
  margin: Wad;
  qty: Wad;
  entry: Wad;
  liq: Wad | null;
  /** Close spread the maker committed to, as a fraction. */
  cs: Wad;
  commit: string;
  block: number;
  openedAt: number;
}

export interface Activity {
  t: number;
  title: string;
  sub: string;
  icon: IconName;
}

export interface Offer {
  id: string;
  sym: string;
  back: Wad;
  max: Wad;
  open: number;
  close: number;
  exp: string;
  fills: number;
  earned: Wad;
}

export interface LastChain {
  what: string;
  commit: string;
  block: number;
}

export interface Ledger {
  priv: Record<string, Wad>;
  positions: Position[];
  history: Activity[];
  offers: Offer[];
  lp: Record<string, Wad>;
  lastChain: LastChain | null;
  /** Amount of each token demo-shielded out of the real public wallet (caps further shields). */
  shielded: Record<string, Wad>;
}

export interface Account {
  addr: `0x${string}`;
  paddr: string;
}

export interface FlowStep {
  t: string;
  d?: string;
  ms: number;
  proof?: boolean;
}

export interface FlowResult {
  rows: Array<[ReactNode, ReactNode]>;
  toast: string;
}

export interface FlowSpec {
  title: string;
  steps: FlowStep[];
  done: () => FlowResult;
}

export type ModalState =
  | { kind: 'connect'; error?: string }
  | { kind: 'network' }
  | { kind: 'sign' }
  | { kind: 'account' }
  | { kind: 'move'; move: 'shield' | 'unshield' | 'send' }
  | { kind: 'lpadd'; sym: string }
  | { kind: 'flow'; flow: FlowSpec; id: number };

export interface Toast {
  id: number;
  msg: string;
  warn?: boolean;
}

export const BLOCK_BASE = 153118480;
export const emptyLedger = (): Ledger => ({ priv: {}, positions: [], history: [], offers: [], lp: {}, lastChain: null, shielded: {} });

interface AppState {
  veiled: boolean;
  q: string;
  account: Account | null;
  ledger: Ledger;
  sel: string;
  mode: 'spot' | 'perps';
  side: Side;
  lev: number;
  size: string;
  spotSide: SpotSide;
  spotAmt: string;
  slip: number;
  tf: Timeframe;
  ptab: 'pos' | 'hist';
  swapFrom: string;
  swapTo: string;
  swapAmt: string;
  openChain: Record<string, boolean>;
  ofExp: string;
  modal: ModalState | null;
  modalLocked: boolean;
  toasts: Toast[];
  set: (p: Partial<AppState>) => void;
  setLedger: (fn: (l: Ledger) => Ledger) => void;
  openModal: (m: ModalState, locked?: boolean) => void;
  closeModal: (force?: boolean) => void;
  toast: (msg: string, warn?: boolean) => void;
  runFlow: (flow: FlowSpec) => void;
}

let toastId = 0;
let flowId = 0;

export const useApp = create<AppState>((set, get) => ({
  veiled: false,
  q: '',
  account: null,
  ledger: emptyLedger(),
  sel: DEFAULT_SYMBOL,
  mode: 'perps',
  side: 'long',
  lev: 2,
  size: '500',
  spotSide: 'buy',
  spotAmt: '500',
  slip: PROTOCOL.defaultSlippagePct,
  tf: '1h',
  ptab: 'pos',
  swapFrom: 'USDG',
  swapTo: 'TSLA',
  swapAmt: '1000',
  openChain: {},
  ofExp: '24 hours',
  modal: null,
  modalLocked: false,
  toasts: [],
  set: (p) => set(p),
  setLedger: (fn) => set((s) => ({ ledger: fn(s.ledger) })),
  openModal: (m, locked = false) => set({ modal: m, modalLocked: locked }),
  closeModal: (force) => {
    if (get().modalLocked && !force) return;
    set({ modal: null, modalLocked: false });
  },
  toast: (msg, warn) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, msg, warn }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3320);
  },
  runFlow: (flow) => set({ modal: { kind: 'flow', flow, id: ++flowId }, modalLocked: true }),
}));

/* ---------- ledger helpers (pure) ---------- */
export const bal = (o: Record<string, Wad>, k: string): Wad => o[k] ?? 0n;
export const addBal = (o: Record<string, Wad>, k: string, d: Wad): Record<string, Wad> => ({ ...o, [k]: bal(o, k) + d });
export const logAct = (l: Ledger, title: string, sub: string, icon: IconName): Ledger => ({
  ...l,
  history: [{ t: Date.now(), title, sub: IS_MAINNET ? `${sub} · Simulated` : sub, icon }, ...l.history].slice(0, 100),
});
export const chainSaw = (l: Ledger, what: string): Ledger => ({
  ...l,
  lastChain: { what, commit: randomHex(32), block: BLOCK_BASE + Math.floor(200 + Math.random() * 8800) },
});

/** New wallets start with the prototype's demo private balance. */
export function seedLedger(): Ledger {
  const now = Date.now();
  // Mainnet: a plainly labelled practice balance, never a fabricated on-chain history (audit web M2).
  if (IS_MAINNET)
    return {
      ...emptyLedger(),
      priv: { USDG: parseWad('10000')! },
      history: [{ t: now, title: 'Practice balance: 10,000 USDG', sub: 'Simulated for demo trading. Nothing is on-chain.', icon: 'info' }],
    };
  const l: Ledger = {
    ...emptyLedger(),
    priv: { USDG: parseWad('12500')!, TSLA: parseWad('4')!, AMZN: parseWad('10')! },
    history: [
      { t: now - 3600e3 * 20, title: 'Bought 10.0000 AMZN', sub: 'Private swap through the AMZN pool', icon: 'trade' },
      { t: now - 3600e3 * 25, title: 'Shielded 4 TSLA', sub: 'Public deposit from your wallet', icon: 'shieldIn' },
      { t: now - 3600e3 * 26, title: 'Shielded 12,500 USDG', sub: 'Public deposit from your wallet', icon: 'shieldIn' },
    ],
  };
  return chainSaw(l, 'The AMZN pool changed');
}

/* ---------- persistence (per wallet, browser only) ---------- */
// Keys include the chain so a testnet ledger or session never carries over to mainnet (audit web M1).
const LEDGER_KEY = (addr: string) => `velum:demo:v2:${CHAIN.id}:${addr.toLowerCase()}`;
// v3: private addresses come from the SIWE-shaped message and a domain-separated hash (audit web L8),
// so v2 sessions (old message) are not reused; the wallet signs once more and the ledger carries over.
const SESSION_KEY = `velum:session:v3:${CHAIN.id}`;
const SIGNER_KEY = `velum:signer:v1:${CHAIN.id}`;
const WALLET_RE = /^0x[0-9a-f]{40}$/;

/** A Velum private address (velum1…). Lives here, not in lib/account.ts, so pages don't bundle the signing code. */
export const isPrivateAddress = (s: string) => /^velum1[0-9a-z]{10,}$/i.test(s);

/** Stored ledgers are validated field by field; anything malformed is dropped, never trusted (audit web L6). */
export function loadLedger(addr: string): Ledger | null {
  try {
    const raw = localStorage.getItem(LEDGER_KEY(addr));
    if (!raw) return null;
    const l = decodeLedger(raw);
    if (!l) localStorage.removeItem(LEDGER_KEY(addr));
    return l;
  } catch {
    return null;
  }
}

export function saveLedger(addr: string, l: Ledger) {
  try {
    localStorage.setItem(LEDGER_KEY(addr), encodeLedger(l));
  } catch {
    /* storage unavailable: demo continues in memory */
  }
}

/** wallet (lowercase 0x address) -> value, keeping only entries that pass `ok`. */
function readMap(key: string, ok: (v: unknown) => boolean): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) || '{}');
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([k, x]) => WALLET_RE.test(k) && ok(x))) as Record<string, string>;
  } catch {
    return {};
  }
}

const readSessions = () => readMap(SESSION_KEY, (x) => typeof x === 'string' && isPrivateAddress(x));

/** v2 sessions hold private addresses from the old message; nothing reads them, so don't keep the wallet link around. */
export function dropLegacySessions() {
  try {
    localStorage.removeItem(`velum:session:v2:${CHAIN.id}`);
  } catch {
    /* ignore */
  }
}

/** The private address is public data (a receiving address); the signature is never stored. */
export function rememberSession(addr: string, paddr: string) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...readSessions(), [addr.toLowerCase()]: paddr }));
  } catch {
    /* ignore */
  }
}

export function recallSession(addr: string): string | null {
  return readSessions()[addr.toLowerCase()] ?? null;
}

export function forgetSession(addr: string) {
  try {
    const s = readSessions();
    delete s[addr.toLowerCase()];
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/**
 * Wallets already shown to sign deterministically in this browser (two identical signatures),
 * so later openings need one signature. Stores only a flag, never a signature or key.
 */
export function signerVerified(addr: string): boolean {
  return readMap(SIGNER_KEY, (x) => x === '1')[addr.toLowerCase()] === '1';
}

export function markSignerVerified(addr: string) {
  try {
    localStorage.setItem(SIGNER_KEY, JSON.stringify({ ...readMap(SIGNER_KEY, (x) => x === '1'), [addr.toLowerCase()]: '1' }));
  } catch {
    /* ignore: the check simply runs again next time */
  }
}

/* ---------- derived values ---------- */
export const isConnected = (s: Pick<AppState, 'account'>) => s.account !== null;
