import { IS_MAINNET } from '@velum/config';

/**
 * Real perps through Hyperliquid (lib/hyperliquid): Robinhood Chain mainnet builds, unless the build turns it off with
 * NEXT_PUBLIC_HL_PERPS=off (then the Perps ticket stays the simulated one). Kept apart from the client so the trade page
 * can decide without downloading the Hyperliquid SDK.
 */
export const HL_PERPS = IS_MAINNET && process.env.NEXT_PUBLIC_HL_PERPS !== 'off';
