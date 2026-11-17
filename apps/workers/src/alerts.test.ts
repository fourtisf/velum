/**
 * Telegram alerts (src/alerts/core.ts): the bot's commands and links, liquidation warnings (once, re-armed after moving
 * away), fills summed per order (liquidations said plainly), deposits / withdrawals / USDC received, the first check
 * never replaying history, and the weight budget.
 */
import { describe, expect, it } from 'vitest';
import { HL_MARKETS } from '@velum/config/src/hyperliquid';
import { checkWallet, fillMessages, handleMessage, ledgerMessages, liqWarnings, roundMs, type AlertStore, type HlReader, type Sub, type WalletState } from './alerts/core';

const W = '0x92ef4c8d8df09a9ae7ed9a12409bc9a84fb70e7b';
const TSLA = HL_MARKETS.TSLA!.coin;

function memStore(codes: Record<string, string> = {}) {
  const subs = new Map<number, Sub>();
  const states = new Map<string, WalletState>();
  const store: AlertStore = {
    takeCode: async (c) => {
      const v = codes[c] ?? null;
      delete codes[c];
      return v;
    },
    getSub: async (id) => subs.get(id) ?? null,
    setSub: async (id, s) => void (s ? subs.set(id, s) : subs.delete(id)),
    allSubs: async () => subs,
    getState: async (a) => states.get(a) ?? null,
    setState: async (a, s) => void states.set(a, s),
  };
  return { store, subs, states };
}

describe('bot commands', () => {
  it('a fresh code links the chat to its wallet once; an expired or reused one says so', async () => {
    const { store, subs } = memStore({ abcdefgh12345678: W });
    const r = await handleMessage(store, 7, '/start abcdefgh12345678');
    expect(r.text).toMatch(/Alerts are on for 0x92ef…0e7b/);
    expect(subs.get(7)).toEqual({ wallets: [W] });
    expect((await handleMessage(store, 7, '/start abcdefgh12345678')).text).toMatch(/expired or was already used/);
    expect((await handleMessage(store, 7, '/status')).text).toMatch(/0x92ef…0e7b/);
    expect((await handleMessage(store, 7, '/stop')).text).toMatch(/Alerts are off/);
    expect(subs.has(7)).toBe(false);
    expect((await handleMessage(store, 7, 'hello')).text).toMatch(/Portfolio → Telegram alerts/);
  });

  it('a chat follows at most five wallets', async () => {
    const codes: Record<string, string> = {};
    for (let i = 0; i < 6; i++) codes[`code000${i}xxxx`] = `0x${String(i).repeat(40)}`;
    const { store, subs } = memStore(codes);
    for (let i = 0; i < 5; i++) await handleMessage(store, 1, `/start code000${i}xxxx`);
    expect((await handleMessage(store, 1, '/start code0005xxxx')).text).toMatch(/already follows 5 wallets/);
    expect(subs.get(1)!.wallets).toHaveLength(5);
  });
});

describe('what is new', () => {
  it('warns once when a position comes within 10% of liquidation, and again only after it moved past 15%', () => {
    const pos = (value: string) => [{ coin: TSLA, szi: '2', positionValue: value, liquidationPx: '350' }];
    const a = liqWarnings(pos('760'), {}); // mark 380: 7.9% away
    expect(a.messages[0]).toBe('⚠️ TSLA long is 7.9% from liquidation (mark 380.00, liquidation 350.00). Add margin or reduce it in Velum.');
    const b = liqWarnings(pos('750'), a.warned);
    expect(b.messages).toEqual([]);
    const c = liqWarnings(pos('800'), b.warned); // 12.5%: still armed off
    expect(c.messages).toEqual([]);
    const d = liqWarnings(pos('840'), c.warned); // 16.7%: re-armed
    expect(d.warned[TSLA]).toBe(false);
    expect(liqWarnings(pos('760'), d.warned).messages).toHaveLength(1);
  });

  it('fills: one message per order, summed, with P&L; liquidations said plainly; other coins ignored', () => {
    const f = fillMessages(
      [
        { coin: TSLA, px: '392', sz: '1', dir: 'Close Long', closedPnl: '10', time: 1001, oid: 5 },
        { coin: TSLA, px: '394', sz: '1', dir: 'Close Long', closedPnl: '12', time: 1002, oid: 5 },
        { coin: TSLA, px: '300', sz: '0.5', dir: 'Close Long', closedPnl: '-40', time: 1003, oid: 6, liquidation: { markPx: '300' } },
        { coin: 'BTC', px: '1', sz: '1', dir: 'Open Long', closedPnl: '0', time: 1004, oid: 7 },
        { coin: TSLA, px: '380', sz: '1', dir: 'Open Long', closedPnl: '0', time: 900, oid: 1 },
      ],
      1000,
    );
    expect(f.messages).toEqual(['✅ TSLA: Close Long 2 at 393.00 · P&L +$22.00', '🔴 TSLA position liquidated 0.5 at 300.00 · P&L -$40.00']);
    expect(f.latest).toBe(1004);
  });

  it('ledger: deposits, withdrawals and USDC received; internal moves ignored', () => {
    const l = ledgerMessages(
      [
        { time: 11, delta: { type: 'deposit', usdc: '25.5' } },
        { time: 12, delta: { type: 'withdraw', usdc: '10', fee: '1' } },
        { time: 13, delta: { type: 'send', usdc: '449.8', user: '0xf70da97812cb96acdf810712aa562db8dfa3dbef', destination: W } },
        { time: 14, delta: { type: 'send', usdc: '5', user: W, destination: W } },
        { time: 9, delta: { type: 'deposit', usdc: '1' } },
      ],
      10,
      W,
    );
    expect(l.messages).toEqual(['💰 Deposit of $25.50 arrived in your perps account.', '📤 Withdrawal of $10.00 sent to Arbitrum (fee $1.00).', '💰 $449.80 received in your perps account.']);
  });

  it('the first check starts from now (no old history); later checks send what is new, tagged with the wallet', async () => {
    const { store } = memStore();
    let fills: Array<{ coin: string; px: string; sz: string; dir: string; closedPnl: string; time: number; oid: number }> = [{ coin: TSLA, px: '380', sz: '1', dir: 'Open Long', closedPnl: '0', time: 500, oid: 1 }];
    const hl: HlReader = { positions: async () => [], fills: async (_w, from) => fills.filter((f) => f.time > from), ledger: async () => [] };
    expect(await checkWallet(store, hl, W, 1000)).toEqual([]);
    fills = [...fills, { coin: TSLA, px: '390', sz: '1', dir: 'Close Long', closedPnl: '10', time: 1500, oid: 2 }];
    expect(await checkWallet(store, hl, W, 2000)).toEqual(['✅ TSLA: Close Long 1 at 390.00 · P&L +$10.00\n(0x92ef…0e7b)']);
    expect(await checkWallet(store, hl, W, 3000)).toEqual([]);
  });

  it('paces rounds to stay within the weight budget', () => {
    expect(roundMs(1)).toBe(60_000);
    expect(roundMs(100)).toBe(420_000);
  });
});
