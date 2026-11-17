/**
 * Velum's token contract address ("CA") on Robinhood Chain, shown on the landing page (owner request).
 * Set at build time with NEXT_PUBLIC_TOKEN_CA. Only an exact EIP-55 checksummed 0x address counts: an
 * empty, malformed, all-lowercase or wrongly checksummed value is "not set", so the page says
 * "Coming soon" and never shows or copies it. The explorer link always points at Robinhood Chain
 * mainnet (where the token lives), whatever network this build serves.
 */
import mainnetJson from '@velum/config/robinhood-mainnet.json';
import { getAddress, isAddress, type Address } from 'viem';

/** The checksummed address, or null when `raw` is anything but a correctly checksummed address. */
export function parseTokenCa(raw: unknown): Address | null {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  // viem's strict isAddress still accepts all-lowercase addresses (no checksum to check), so the value
  // must also equal its own checksummed form.
  if (!isAddress(raw, { strict: true })) return null;
  const sum = getAddress(raw);
  return sum === raw ? sum : null;
}

/**
 * The VELUM token on Robinhood Chain mainnet (owner-provided, 2026-11-17), shown when NEXT_PUBLIC_TOKEN_CA does not set
 * a valid one. Verified on chain that day: contract code present, name() and symbol() "VELUM", decimals() 18,
 * totalSupply() 1,000,000,000 tokens.
 */
export const VELUM_TOKEN_CA: Address = '0xa9721E7ee2C84fa60c772a82B5021485a0d2C5Ec';

/** The CA the site shows: a valid NEXT_PUBLIC_TOKEN_CA, else the verified VELUM token above. */
export const tokenCaOrDefault = (raw: unknown): Address => parseTokenCa(raw) ?? VELUM_TOKEN_CA;

/** 0x1234…abcd */
export const shortCa = (ca: Address): string => `${ca.slice(0, 6)}…${ca.slice(-4)}`;

/** Robinhood Chain mainnet explorer, from the verified config (https only). */
const MAINNET_EXPLORER = /^https:\/\/[a-z0-9.-]+$/i.test(mainnetJson.network.explorer) ? mainnetJson.network.explorer : null;

/** The explorer page of `ca` on Robinhood Chain mainnet, or null without a usable explorer URL. */
export const caExplorerUrl = (ca: Address): string | null => (MAINNET_EXPLORER ? `${MAINNET_EXPLORER}/address/${ca}` : null);

/**
 * Copies the full checksummed address: the Clipboard API, else a hidden textarea and execCommand (older
 * browsers, non-secure contexts). Resolves to whether it worked; never copies anything else.
 */
export async function copyTokenCa(ca: Address): Promise<boolean> {
  if (parseTokenCa(ca) !== ca) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(ca);
      return true;
    }
  } catch {
    // fall through to the textarea fallback
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = ca;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
