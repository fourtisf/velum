/**
 * Portfolio P&L on mainnet (lib/costBasis.ts): average cost from the wallet's own trades read from the chain. Buys with
 * USDG and with ETH (the USDG the ETH became, read from the receipt), sells (realized P&L), swaps carrying cost over,
 * sends, and tokens without a known cost (transfers in, or more held than the trades explain) showing no P&L.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

import { UNISWAP } from '@velum/config/src/uniswap';
import { pad, type Hex } from 'viem';
import { costBasis, pnlOf } from '@/lib/costBasis';
import { usdgFromEthLeg, type ActKind, type Move, type WalletAct } from '@/lib/walletActivity';
import { W } from './helpers';

const usdg = (n: string): Move => ({ sym: 'USDG', units: BigInt(Math.round(Number(n) * 1e6)), decimals: 6 });
const tok = (sym: string, n: string): Move => ({ sym, units: W(n), decimals: 18 });
let block = 0n;
const act = (kind: ActKind, out: Move[], ins: Move[], extra: Partial<WalletAct> = {}): WalletAct => ({
  hash: `0x${(++block).toString(16).padStart(64, '0')}` as Hex,
  block,
  kind,
  out,
  in: ins,
  ethPaid: 0n,
  usdCost: null,
  counterparty: null,
  time: null,
  ...extra,
});

describe('cost basis', () => {
  it('a buy with USDG costs the USDG paid; P&L is value minus cost', () => {
    const b = costBasis([act('buy', [usdg('100')], [tok('TSLA', '0.25')])]);
    expect(b.TSLA).toEqual({ qty: W('0.25'), cost: W('100'), realized: 0n, unknown: false });
    // 0.25 TSLA now worth 110: +10, +10%.
    expect(pnlOf(b.TSLA, W('0.25'), W('110'))).toEqual({ cost: W('100'), pnl: W('10'), bps: 1000 });
    expect(pnlOf(b.TSLA, W('0.25'), W('95'))).toEqual({ cost: W('100'), pnl: W('-5'), bps: -500 });
  });

  it('a buy with ETH costs the USDG the ETH became in the swap; unknown without it', () => {
    const b = costBasis([act('buy', [], [tok('NVDA', '0.116')], { ethPaid: 10n ** 16n, usdCost: 18_300000n })]);
    expect(b.NVDA!.cost).toBe(W('18.3'));
    expect(b.NVDA!.unknown).toBe(false);
    const u = costBasis([act('buy', [], [tok('NVDA', '0.116')], { ethPaid: 10n ** 16n, usdCost: null })]);
    expect(u.NVDA!.unknown).toBe(true);
    expect(pnlOf(u.NVDA, W('0.116'), W('18'))).toBeNull();
  });

  it('average cost over several buys; a partial sell realizes P&L and keeps the average', () => {
    const b = costBasis([
      act('buy', [usdg('100')], [tok('AMD', '1')]),
      act('buy', [usdg('300')], [tok('AMD', '1')]),
      act('sell', [tok('AMD', '1')], [usdg('250')]),
    ]);
    // Average 200; sold 1 for 250: +50 realized; 1 left costing 200.
    expect(b.AMD).toEqual({ qty: W('1'), cost: W('200'), realized: W('50'), unknown: false });
  });

  it('replays oldest first whatever the order given', () => {
    const buy = act('buy', [usdg('100')], [tok('AMD', '1')]);
    const sell = act('sell', [tok('AMD', '0.5')], [usdg('60')]);
    expect(costBasis([sell, buy]).AMD).toEqual(costBasis([buy, sell]).AMD);
    expect(costBasis([sell, buy]).AMD!.realized).toBe(W('10'));
  });

  it('a swap carries the cost to the new token; a send removes average cost', () => {
    const b = costBasis([act('buy', [usdg('100')], [tok('TSLA', '1')]), act('swap', [tok('TSLA', '1')], [tok('META', '0.2')]), act('buy', [usdg('50')], [tok('AAPL', '1')]), act('send', [tok('AAPL', '0.5')], [])]);
    expect(b.TSLA).toMatchObject({ qty: 0n, cost: 0n, unknown: false });
    expect(b.META).toMatchObject({ qty: W('0.2'), cost: W('100'), unknown: false });
    expect(b.AAPL).toMatchObject({ qty: W('0.5'), cost: W('25'), unknown: false });
  });

  it('no P&L for tokens without a known cost: a transfer in, more held than traded, or selling more than tracked', () => {
    const recv = costBasis([act('buy', [usdg('100')], [tok('COIN', '1')]), act('receive', [], [tok('COIN', '1')])]);
    expect(recv.COIN!.unknown).toBe(true);
    expect(pnlOf(recv.COIN, W('2'), W('300'))).toBeNull();
    // Bought 1 in the window but the wallet holds 3 (the rest from before): no P&L.
    const more = costBasis([act('buy', [usdg('100')], [tok('MSFT', '1')])]);
    expect(pnlOf(more.MSFT, W('3'), W('330'))).toBeNull();
    // Rounding dust is fine.
    expect(pnlOf(more.MSFT, W('1') - 10n ** 8n, W('110'))).not.toBeNull();
    const oversold = costBasis([act('buy', [usdg('100')], [tok('NFLX', '1')]), act('sell', [tok('NFLX', '2')], [usdg('210')])]);
    expect(oversold.NFLX!.unknown).toBe(true);
    // No live value, or nothing held: no P&L.
    expect(pnlOf(more.MSFT, W('1'), null)).toBeNull();
    expect(pnlOf(more.MSFT, 0n, W('0'))).toBeNull();
  });

  it('USDG and ETH moves are not holdings with a P&L', () => {
    const b = costBasis([act('buy', [usdg('100')], [tok('TSLA', '1')])]);
    expect(Object.keys(b)).toEqual(['TSLA']);
  });
});

describe('the cost of a buy with ETH, from its receipt', () => {
  const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex;
  const cfg = UNISWAP!;
  const ROUTER = cfg.contracts.universalRouter;
  const log = (token: string, from: string, to: string, v: bigint) => ({ address: token, topics: [T, pad(from as Hex), pad(to as Hex)] as Hex[], data: `0x${v.toString(16).padStart(64, '0')}` as Hex });
  it('is the USDG that left the ETH leg pool, nothing else', () => {
    const logs = [
      log(cfg.contracts.weth, ROUTER, cfg.ethLeg.address, 10n ** 16n),
      log(cfg.usdg.address, cfg.ethLeg.address, ROUTER, 18_300000n),
      log(cfg.usdg.address, ROUTER, '0x2222222222222222222222222222222222222222', 18_300000n),
      log('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', '0x2222222222222222222222222222222222222222', '0x1111111111111111111111111111111111111111', W('0.116')),
    ];
    expect(usdgFromEthLeg(logs, cfg.usdg.address, cfg.ethLeg.address)).toBe(18_300000n);
    expect(usdgFromEthLeg(logs.slice(2), cfg.usdg.address, cfg.ethLeg.address)).toBeNull();
  });
});
