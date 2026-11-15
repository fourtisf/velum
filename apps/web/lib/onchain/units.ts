/**
 * Conversions between what the user types (a Wad: 18-decimal fixed point, lib/amount.ts) and token base
 * units with the token's exact decimals read from chain (USDG 6, Stock Tokens 18). Integer-only. An amount
 * with more decimal places than the token has is refused, never rounded silently.
 */
import { WAD, type Wad } from '@velum/math';
import { formatUnits } from 'viem';

/** Decimals a listed token may have (ERC-20 allows up to 255; Velum's tokens use 6 and 18). */
export const MAX_TOKEN_DECIMALS = 18;

export type UnitsResult = { ok: true; units: bigint } | { ok: false; reason: 'decimals' | 'negative' };

/** A typed amount in base units of a token with `decimals`; refused when it has more decimals than the token. */
export function wadToUnits(w: Wad, decimals: number): UnitsResult {
  if (w < 0n) return { ok: false, reason: 'negative' };
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) throw new RangeError(`unsupported token decimals ${decimals}`);
  const unit = 10n ** BigInt(MAX_TOKEN_DECIMALS - decimals);
  if (w % unit !== 0n) return { ok: false, reason: 'decimals' };
  return { ok: true, units: w / unit };
}

/** Base units as a Wad (exact: decimals <= 18). */
export function unitsToWad(units: bigint, decimals: number): Wad {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) throw new RangeError(`unsupported token decimals ${decimals}`);
  return units * 10n ** BigInt(MAX_TOKEN_DECIMALS - decimals);
}

/** Base units floored to a Wad with at most `dp` decimals: for "Max" buttons (never more than is there). */
export function unitsToInput(units: bigint, decimals: number, dp: number): string {
  const w = unitsToWad(units, decimals);
  const step = 10n ** BigInt(MAX_TOKEN_DECIMALS - Math.min(dp, decimals));
  const floored = (w / step) * step;
  return formatUnits(floored, MAX_TOKEN_DECIMALS);
}

/** The exact decimal string of base units (no rounding, trailing zeros trimmed), e.g. 1500000 at 6 -> "1.5". */
export const exactUnits = (units: bigint, decimals: number): string => formatUnits(units, decimals);

/** A 1e18 price (USDG per token) as a Wad: prices on chain are already 1e18-scaled. */
export const priceToWad = (p: bigint): Wad => p;

/** 1 token in base units. */
export const oneToken = (decimals: number): bigint => 10n ** BigInt(decimals);

export { WAD };
