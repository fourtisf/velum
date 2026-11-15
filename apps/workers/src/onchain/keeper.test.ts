import { describe, expect, it } from 'vitest';
import { gasCostUsdg, liquidationEconomics, type LiquidationInput } from './keeper';

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const VALUE_SCALE = 10n ** 30n; // 36 - 6 (USDG decimals)

/** A 5x long of 1000 USDG at `entry`, priced at `price`, funding ignored. */
function long5x(entry: bigint, price: bigint, extra: Partial<LiquidationInput> = {}): LiquidationInput {
  const qty = (1000n * E6 * VALUE_SCALE) / entry;
  const takerMargin = 200n * E6;
  const pnl = (qty * (price - entry)) / VALUE_SCALE;
  return { qty, price, valueScale: VALUE_SCALE, takerMargin, makerMargin: 200n * E6, takerClaim: takerMargin + pnl, keeperRewardCap: E6, insurance: 1000n * E6, ...extra };
}

describe('liquidation economics (PerpsBase._liquidationSide, PerpsLiquidation)', () => {
  it('not liquidatable above maintenance (10% of notional)', () => {
    const e = liquidationEconomics(long5x(400n * E18, 370n * E18)); // -7.5%: claim 12.5% of 1000 > 10% of 925
    expect(e.liquidatable).toBe(false);
  });

  it('a long 12% down: the taker side, half the 1% penalty as reward, not urgent', () => {
    const e = liquidationEconomics(long5x(400n * E18, 352n * E18));
    expect(e.liquidatable).toBe(true);
    expect(e.takerSide).toBe(true);
    expect(e.notional).toBe(880n * E6);
    expect(e.loserClaim).toBe(80n * E6);
    expect(e.reward).toBe(44n * 10n ** 5n); // 1% of 880 = 8.8, half = 4.4 USDG
    expect(e.urgent).toBe(false);
  });

  it('urgent below half the maintenance margin, or when the loser cannot pay the full penalty', () => {
    const deep = liquidationEconomics(long5x(400n * E18, 335n * E18)); // claim 37.5 < 5% of 837.5
    expect(deep.urgent).toBe(true);
    const broke = liquidationEconomics(long5x(400n * E18, 322n * E18)); // claim 5 < penalty 8.05
    expect(broke.urgent).toBe(true);
    // Penalty capped at the claim (5 USDG): reward 2.5, topped up to min(half the full penalty, 1 USDG cap)? 2.5 > 1: no top-up.
    expect(broke.reward).toBe(25n * 10n ** 5n);
    const underwater = liquidationEconomics(long5x(400n * E18, 310n * E18)); // claim negative: no penalty
    expect(underwater.loserClaim < 0n).toBe(true);
    expect(underwater.reward).toBe(E6); // top-up to the 1 USDG cap from insurance
    expect(liquidationEconomics(long5x(400n * E18, 310n * E18, { insurance: 5n * E6 })).reward).toBe(5n * 10n ** 5n); // 10% of the fund
    expect(liquidationEconomics(long5x(400n * E18, 310n * E18, { insurance: 0n })).reward).toBe(0n);
  });

  it('the maker side when the price rises', () => {
    const e = liquidationEconomics(long5x(400n * E18, 448n * E18)); // +12%: maker claim 80 < 10% of 1120
    expect(e.liquidatable).toBe(true);
    expect(e.takerSide).toBe(false);
    expect(e.loserClaim).toBe(80n * E6);
  });

  it('gas cost in USDG base units at a rough ETH price', () => {
    // 300k gas at 0.1 gwei = 3e13 wei = 0.00003 ETH; at 4000 USD = 0.12 USDG.
    expect(gasCostUsdg(300_000n, 10n ** 8n, 4000n, 6)).toBe(120_000n);
    expect(gasCostUsdg(1n, 1n, 1n, 6)).toBe(1n); // rounded up
  });
});
