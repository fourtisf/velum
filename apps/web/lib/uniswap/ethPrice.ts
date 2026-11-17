'use client';
/**
 * The live ETH price on Robinhood Chain mainnet, in USDG per ETH, read from the curated ETH leg (the WETH/USDG 0.01% v3
 * pool, packages/config/uniswap-mainnet.json ethLeg) every 20 s: the pool's current price, so ETH balances and amounts
 * can be shown in dollars. Kept in the markets store (lib/markets.ts tokPx('ETH')), which treats it as unknown once it is
 * older than three minutes.
 */
import { UNISWAP, sqrtPriceToWad } from '@velum/config/src/uniswap';
import { publicClient } from '../chain';
import { useMarkets } from '../markets';

const SLOT0 = [{ type: 'function', name: 'slot0', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' }] }] as const;

/** USDG per ETH as a wad, from the ETH leg's current price; null when unreadable. */
export async function readEthPrice(): Promise<bigint | null> {
  const cfg = UNISWAP;
  if (!cfg) return null;
  try {
    const [sqrt] = await publicClient.readContract({ address: cfg.ethLeg.address, abi: SLOT0, functionName: 'slot0' });
    // WETH (18 decimals) against USDG: the same conversion as a stock pool, with WETH in the stock's place.
    return sqrtPriceToWad(sqrt, cfg.contracts.weth.toLowerCase() < cfg.usdg.address.toLowerCase(), 18, cfg.usdg.decimals);
  } catch {
    return null;
  }
}

/** Keeps the ETH price fresh while the app is open (mainnet builds; started from components/Providers.tsx). Returns stop. */
export function startEthPrice(): () => void {
  let alive = true;
  const tick = async () => {
    const px = await readEthPrice();
    if (alive && px !== null) useMarkets.setState({ ethPx: { px, at: Date.now() } });
  };
  void tick();
  const id = setInterval(tick, 20_000);
  return () => {
    alive = false;
    clearInterval(id);
  };
}
