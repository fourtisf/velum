/**
 * Encode and decode the browser-only demo ledger (audit web L6). localStorage is untrusted input:
 * another tab, an extension, an old build or a curious user can put anything there. Decoding
 * checks the type of every field, turns "123n" strings into bigint only for known money fields,
 * and drops whatever does not fit (one bad entry is dropped, not the whole ledger) instead of
 * letting a malformed value crash a page later.
 */
import { MARKET_SYMBOLS, PROTOCOL, QUOTE_SYMBOL } from '@velum/config';
import type { Wad } from '@velum/math';
import type { IconName } from '@/components/icons';
import type { Activity, LastChain, Ledger, Offer, Position } from './store';

export const OFFER_EXPIRIES = ['6 hours', '24 hours', '7 days'] as const;

const MARKET_SET = new Set(MARKET_SYMBOLS);
const TOKEN_SET = new Set([QUOTE_SYMBOL, ...MARKET_SYMBOLS]);
const ACTIVITY_ICONS = new Set<IconName>(['trade', 'shieldIn', 'shieldOut', 'send', 'swapI', 'drop', 'offer', 'info']);
const EXPIRY_SET = new Set<string>(OFFER_EXPIRIES);

/** No real balance comes near this (1e27 tokens); anything larger is corrupt. */
const MAX_WAD = 10n ** 45n;
const MAX_ITEMS = 200;
const MAX_HISTORY = 100;
const MAX_TEXT = 240;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/* ---------- field decoders: return undefined when the value does not fit ---------- */

/** Money: written as "<digits>n" by encodeLedger. Non-negative and bounded. */
function wad(v: unknown): Wad | undefined {
  if (typeof v !== 'string' || !/^\d{1,46}n$/.test(v)) return undefined;
  const w = BigInt(v.slice(0, -1));
  return w <= MAX_WAD ? w : undefined;
}

function num(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}

function int(v: unknown, min: number, max: number): number | undefined {
  const n = num(v, min, max);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

function text(v: unknown, re?: RegExp): string | undefined {
  return typeof v === 'string' && v.length <= MAX_TEXT && (!re || re.test(v)) ? v : undefined;
}

const ID = /^[a-z0-9]{1,16}$/;
const HASH = /^0x[0-9a-f]{64}$/i;
/** Epoch ms between 2020 and 2100. */
const time = (v: unknown) => int(v, 1_577_836_800_000, 4_102_444_800_000);

/** A record of token -> amount, keeping only allowed keys with valid amounts. */
function balances(v: unknown, keys: Set<string>): Record<string, Wad> {
  const out: Record<string, Wad> = {};
  if (!isObj(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    const w = wad(raw);
    if (keys.has(k) && w !== undefined) out[k] = w;
  }
  return out;
}

function list<T>(v: unknown, decode: (o: Obj) => T | undefined, max: number): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const raw of v.slice(0, max)) {
    const d = isObj(raw) ? decode(raw) : undefined;
    if (d !== undefined) out.push(d);
  }
  return out;
}

function position(o: Obj): Position | undefined {
  const id = text(o.id, ID);
  const sym = text(o.sym);
  const side = o.side === 'long' || o.side === 'short' ? o.side : undefined;
  const lev = num(o.lev, 1, PROTOCOL.maxLeverage);
  const margin = wad(o.margin);
  const qty = wad(o.qty);
  const entry = wad(o.entry);
  const liq = o.liq === null ? null : wad(o.liq);
  const cs = wad(o.cs);
  const commit = text(o.commit, HASH);
  const block = int(o.block, 0, Number.MAX_SAFE_INTEGER);
  const openedAt = time(o.openedAt);
  if (!id || !sym || !MARKET_SET.has(sym) || !side || lev === undefined || margin === undefined || qty === undefined) return undefined;
  if (entry === undefined || entry === 0n || liq === undefined || cs === undefined || cs >= 10n ** 18n || !commit || block === undefined || openedAt === undefined) return undefined;
  return { id, sym, side, lev, margin, qty, entry, liq, cs, commit, block, openedAt };
}

function activity(o: Obj): Activity | undefined {
  const t = time(o.t);
  const title = text(o.title);
  const sub = text(o.sub);
  const icon = typeof o.icon === 'string' && ACTIVITY_ICONS.has(o.icon as IconName) ? (o.icon as IconName) : undefined;
  return t !== undefined && title !== undefined && sub !== undefined && icon ? { t, title, sub, icon } : undefined;
}

function offer(o: Obj): Offer | undefined {
  const id = text(o.id, ID);
  const sym = text(o.sym);
  const back = wad(o.back);
  const max = wad(o.max);
  const open = num(o.open, 0, 1000);
  const close = num(o.close, 0, 1000);
  const exp = typeof o.exp === 'string' && EXPIRY_SET.has(o.exp) ? o.exp : undefined;
  const fills = int(o.fills, 0, 1_000_000);
  const earned = wad(o.earned);
  if (!id || !sym || !MARKET_SET.has(sym) || back === undefined || max === undefined || open === undefined || close === undefined) return undefined;
  if (!exp || fills === undefined || earned === undefined) return undefined;
  return { id, sym, back, max, open, close, exp, fills, earned };
}

function lastChain(v: unknown): LastChain | null {
  if (!isObj(v)) return null;
  const what = text(v.what);
  const commit = text(v.commit, HASH);
  const block = int(v.block, 0, Number.MAX_SAFE_INTEGER);
  return what !== undefined && commit && block !== undefined ? { what, commit, block } : null;
}

/** Parse a stored ledger. Returns null when it is not a ledger at all (the caller starts fresh). */
export function decodeLedger(raw: string): Ledger | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  const positions = list(v.positions, position, MAX_ITEMS).filter((p, i, all) => all.findIndex((x) => x.id === p.id) === i);
  const offers = list(v.offers, offer, MAX_ITEMS).filter((o, i, all) => all.findIndex((x) => x.id === o.id) === i);
  return {
    priv: balances(v.priv, TOKEN_SET),
    positions,
    history: list(v.history, activity, MAX_HISTORY),
    offers,
    lp: balances(v.lp, MARKET_SET),
    lastChain: lastChain(v.lastChain),
    shielded: balances(v.shielded, TOKEN_SET),
  };
}

export function encodeLedger(l: Ledger): string {
  return JSON.stringify(l, (_k, v: unknown) => (typeof v === 'bigint' ? `${v.toString()}n` : v));
}
