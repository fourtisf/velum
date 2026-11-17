/**
 * Telegram alerts for a wallet's real perps account (velum-alerts, src/alerts.ts). Opt-in: the web asks the wallet to
 * sign one message, the API stores a one-time code for that wallet (15 minutes), and the user opens the bot with it
 * ("/start <code>"). From then on the bot sends, for each linked wallet: a warning when a position comes within 10% of
 * its liquidation price, each fill in the Velum markets (closes, take profit / stop loss, liquidations), and deposits,
 * withdrawals and USDC received. /stop deletes the chat's links; /status lists them.
 *
 * Storage is Redis (append-only, deploy/redis-velum.sh): the code (velum:alerts:code:<code>), the chat -> wallets map
 * (velum:alerts:subs) and per-wallet progress (velum:alerts:state:<wallet>). Nothing else about the user is kept.
 * Pure helpers (message text, what is new) are unit-tested; the I/O sits behind small interfaces.
 */
import { HL_MARKETS } from '@velum/config/src/hyperliquid';

export const CODE_KEY = (code: string) => `velum:alerts:code:${code}`;
export const SUBS_KEY = 'velum:alerts:subs';
export const STATE_KEY = (addr: string) => `velum:alerts:state:${addr.toLowerCase()}`;
export const OFFSET_KEY = 'velum:alerts:tg-offset';
export const MAX_WALLETS_PER_CHAT = 5;
/** Warn when the mark is within this share of the liquidation price; warn again only after it moved back past REARM. */
export const LIQ_WARN = 0.1;
export const LIQ_REARM = 0.15;
/** Hyperliquid's info budget is 1200 weight per minute per IP: Velum's alerts use at most this much. */
export const WEIGHT_BUDGET_PER_MIN = 600;
/** clearinghouseState (2) + userFills (20) + userNonFundingLedgerUpdates (20) per wallet and round. */
export const WEIGHT_PER_WALLET = 42;

const SYMBOL = new Map(Object.values(HL_MARKETS).map((m) => [m.coin, m.symbol]));
const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedUsd = (n: number) => (n > 0 ? `+${usd(n)}` : usd(n));
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface Sub {
  wallets: string[];
}
export interface WalletState {
  fillsFrom: number;
  ledgerFrom: number;
  /** coin -> warned (until the mark moves back past LIQ_REARM). */
  warned: Record<string, boolean>;
}

// ---------- Bot commands ----------
export type Reply = { chatId: number; text: string };
export interface AlertStore {
  takeCode(code: string): Promise<string | null>;
  getSub(chatId: number): Promise<Sub | null>;
  setSub(chatId: number, sub: Sub | null): Promise<void>;
  allSubs(): Promise<Map<number, Sub>>;
  getState(addr: string): Promise<WalletState | null>;
  setState(addr: string, s: WalletState): Promise<void>;
}

export const HELP =
  'Velum alerts send you, for your linked wallets: a warning when a perps position nears liquidation, each fill (closes, take profit, stop loss, liquidations), and deposits and withdrawals.\n\nTo link a wallet, open Velum → Portfolio → Telegram alerts.\n/status lists linked wallets, /stop turns alerts off.';

/** What the bot answers to one message (and the subscription change it makes). */
export async function handleMessage(store: AlertStore, chatId: number, text: string): Promise<Reply> {
  const [cmd, arg] = text.trim().split(/\s+/, 2);
  if (cmd === '/start' && arg) {
    const wallet = /^[A-Za-z0-9_-]{8,64}$/.test(arg) ? await store.takeCode(arg) : null;
    if (!wallet || !ADDR.test(wallet)) return { chatId, text: 'This link has expired or was already used. Open Velum → Portfolio → Telegram alerts to get a new one.' };
    const sub = (await store.getSub(chatId)) ?? { wallets: [] };
    const w = wallet.toLowerCase();
    if (!sub.wallets.includes(w)) {
      if (sub.wallets.length >= MAX_WALLETS_PER_CHAT) return { chatId, text: `This chat already follows ${MAX_WALLETS_PER_CHAT} wallets. Send /stop to start over.` };
      sub.wallets.push(w);
      await store.setSub(chatId, sub);
    }
    return { chatId, text: `Alerts are on for ${short(w)}.\n\nYou will get liquidation warnings (within 10%), fills (closes, take profit, stop loss, liquidations), and deposits and withdrawals.\n/stop turns them off.` };
  }
  if (cmd === '/stop') {
    await store.setSub(chatId, null);
    return { chatId, text: 'Alerts are off, and this chat is no longer linked to any wallet.' };
  }
  if (cmd === '/status') {
    const sub = await store.getSub(chatId);
    return { chatId, text: sub?.wallets.length ? `Alerts on for:\n${sub.wallets.map(short).join('\n')}` : 'No wallet linked. Open Velum → Portfolio → Telegram alerts.' };
  }
  return { chatId, text: HELP };
}

// ---------- What is new for a wallet ----------
export interface PositionLike {
  coin: string;
  szi: string;
  positionValue: string;
  liquidationPx: string | null;
}
export interface FillLike {
  coin: string;
  px: string;
  sz: string;
  dir: string;
  closedPnl: string;
  time: number;
  oid: number;
  liquidation?: unknown;
}
export interface LedgerLike {
  time: number;
  delta: { type?: string; usdc?: string; fee?: string; user?: string; destination?: string; amount?: string; token?: string };
}

/** Liquidation warnings for positions within LIQ_WARN (and the updated warned flags). Pure. */
export function liqWarnings(positions: PositionLike[], warned: Record<string, boolean>): { messages: string[]; warned: Record<string, boolean> } {
  const out: string[] = [];
  const next: Record<string, boolean> = {};
  for (const p of positions) {
    const sym = SYMBOL.get(p.coin);
    const size = Math.abs(num(p.szi));
    const liq = num(p.liquidationPx);
    if (!sym || !size || !liq) continue;
    const mark = num(p.positionValue) / size;
    if (!mark) continue;
    const dist = Math.abs(mark - liq) / mark;
    const was = warned[p.coin] === true;
    if (dist < LIQ_WARN && !was) {
      out.push(`⚠️ ${sym} ${num(p.szi) > 0 ? 'long' : 'short'} is ${(dist * 100).toFixed(1)}% from liquidation (mark ${mark.toFixed(2)}, liquidation ${liq.toFixed(2)}). Add margin or reduce it in Velum.`);
      next[p.coin] = true;
    } else next[p.coin] = was && dist < LIQ_REARM;
  }
  return { messages: out, warned: next };
}

/** One message per order filled since `from` in the Velum markets (fills of an order summed). Pure. */
export function fillMessages(fills: FillLike[], from: number): { messages: string[]; latest: number } {
  let latest = from;
  const byOrder = new Map<string, { sym: string; dir: string; sz: number; notional: number; pnl: number; liq: boolean; time: number }>();
  for (const f of fills) {
    if (f.time <= from) continue;
    latest = Math.max(latest, f.time);
    const sym = SYMBOL.get(f.coin);
    if (!sym) continue;
    const key = `${f.coin}:${f.oid}`;
    const o = byOrder.get(key) ?? { sym, dir: f.dir, sz: 0, notional: 0, pnl: 0, liq: false, time: f.time };
    o.sz += num(f.sz);
    o.notional += num(f.sz) * num(f.px);
    o.pnl += num(f.closedPnl);
    o.liq ||= !!f.liquidation;
    o.time = Math.min(o.time, f.time);
    byOrder.set(key, o);
  }
  const messages = [...byOrder.values()]
    .sort((a, b) => a.time - b.time)
    .map((o) => {
      const avg = o.sz ? o.notional / o.sz : 0;
      const head = o.liq ? `🔴 ${o.sym} position liquidated` : `${/close/i.test(o.dir) ? '✅' : '🟢'} ${o.sym}: ${o.dir || 'Trade'}`;
      return `${head} ${+o.sz.toFixed(6)} at ${avg.toFixed(2)}${o.pnl ? ` · P&L ${signedUsd(o.pnl)}` : ''}`;
    });
  return { messages, latest };
}

/** Deposits, withdrawals and USDC received since `from`. Pure. */
export function ledgerMessages(updates: LedgerLike[], from: number, wallet: string): { messages: string[]; latest: number } {
  let latest = from;
  const w = wallet.toLowerCase();
  const out: string[] = [];
  for (const u of [...updates].sort((a, b) => a.time - b.time)) {
    if (u.time <= from) continue;
    latest = Math.max(latest, u.time);
    const d = u.delta ?? {};
    if (d.type === 'deposit') out.push(`💰 Deposit of ${usd(num(d.usdc))} arrived in your perps account.`);
    else if (d.type === 'withdraw') out.push(`📤 Withdrawal of ${usd(num(d.usdc))} sent to Arbitrum${num(d.fee) ? ` (fee ${usd(num(d.fee))})` : ''}.`);
    else if ((d.type === 'send' || d.type === 'spotTransfer') && d.destination?.toLowerCase() === w && d.user?.toLowerCase() !== w) out.push(`💰 ${usd(num(d.usdc ?? d.amount))} received in your perps account.`);
  }
  return { messages: out, latest };
}

/** How long one round over `wallets` wallets must take to stay within WEIGHT_BUDGET_PER_MIN (at least a minute). */
export const roundMs = (wallets: number) => Math.max(60_000, Math.ceil((wallets * WEIGHT_PER_WALLET * 60_000) / WEIGHT_BUDGET_PER_MIN));

export interface HlReader {
  positions(wallet: string): Promise<PositionLike[]>;
  fills(wallet: string, from: number): Promise<FillLike[]>;
  ledger(wallet: string, from: number): Promise<LedgerLike[]>;
}

/** One wallet's alerts since its last check (initialised to now on the first, so old history is never sent). */
export async function checkWallet(store: AlertStore, hl: HlReader, wallet: string, now: number): Promise<string[]> {
  const st = (await store.getState(wallet)) ?? { fillsFrom: now, ledgerFrom: now, warned: {} };
  const [pos, fills, ledger] = await Promise.all([hl.positions(wallet), hl.fills(wallet, st.fillsFrom), hl.ledger(wallet, st.ledgerFrom)]);
  const lw = liqWarnings(pos, st.warned);
  const fm = fillMessages(fills, st.fillsFrom);
  const lm = ledgerMessages(ledger, st.ledgerFrom, wallet);
  await store.setState(wallet, { fillsFrom: fm.latest, ledgerFrom: lm.latest, warned: lw.warned });
  const msgs = [...fm.messages, ...lm.messages, ...lw.messages];
  return msgs.map((m) => `${m}\n(${short(wallet)})`);
}
