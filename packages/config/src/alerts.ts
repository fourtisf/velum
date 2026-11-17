/**
 * Telegram alerts and referral links: the text a wallet signs to link itself to the alerts bot (the web asks, the API
 * verifies), and a wallet's referral code. Pure and dependency-free; import as '@velum/config/src/alerts'.
 */

/** The message a wallet signs (personal_sign, no gas) to get a one-time link to the alerts bot. */
export function alertsMessage(address: string, issuedAt: string): string {
  return `Velum: send perps alerts for this wallet to Telegram.\nWallet: ${address.toLowerCase()}\nIssued: ${issuedAt}\n\nThis signature costs nothing and moves no funds.`;
}

/** How old (or how far in the future) an alerts signature may be. */
export const ALERTS_SIG_MAX_AGE_MS = 10 * 60_000;
/** How long the one-time bot link stays valid. */
export const ALERTS_CODE_TTL_S = 15 * 60;

/** A wallet's referral code: the first 10 hex digits of its address (public anyway, and what the referrer shares). */
export const refCode = (address: string): string => address.slice(2, 12).toLowerCase();
export const REF_CODE_RE = /^[0-9a-f]{10}$/;
