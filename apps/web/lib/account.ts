/**
 * Private account (Phase 2 stand-in). One wallet signature over a fixed message is hashed in the
 * browser into a display private address. The signature stays in memory for this call only and is
 * never stored, cached or sent anywhere. Phase 4 replaces this with HKDF key derivation in @velum/sdk.
 *
 * The message is EIP-4361 (Sign-In with Ethereum) shaped (audit web L8), so wallets show it as a
 * sign-in for this site and warn when the domain does not match the page asking for it. It is not a
 * login: no server ever sees or checks it. It is key material, so it must be byte-for-byte the same
 * every time the same wallet signs on this site, or the wallet would open a different account:
 *  - domain = window.location.host, URI = window.location.origin, Chain ID = the configured chain;
 *  - the statement is fixed per network;
 *  - Nonce is not random: it is derived from the scheme version, chain and wallet address. A random
 *    nonce protects a login against replay; here there is nothing to replay into, and a signature
 *    holder already has the account, which is what the statement warns about;
 *  - Issued At is fixed to the date this scheme (v1) was defined, for the same reason.
 * Changing any of these (including serving the app from another host) changes every derived account,
 * so the canonical host must stay fixed (redirect www and other aliases in Nginx).
 */
import { CHAIN } from '@velum/config';
import { concat, getAddress, isAddress, keccak256, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';

export const SCHEME_VERSION = 'v1';
const ISSUED_AT = new Date('2026-11-14T00:00:00.000Z');

/** Single line, EIP-4361 statement charset (letters, digits, spaces and URI punctuation only). */
export const SIGN_STATEMENT =
  `Open your Velum private account on ${CHAIN.label}. This creates your private keys in this browser. ` +
  'It costs no gas and sends nothing to a server. Only sign this on Velum: anyone with this signature can open your private account.';

/** Deterministic nonce: 16 hex characters, unique per scheme version, chain and wallet. */
export function signNonce(address: Address): string {
  return keccak256(toHex(`velum:private-account:${SCHEME_VERSION}:nonce:${CHAIN.id}:${address.toLowerCase()}`)).slice(2, 18);
}

/** The exact message the wallet signs. Browser only (reads window.location). */
export function buildSignMessage(address: Address, location: Pick<Location, 'host' | 'origin'> = window.location): string {
  return createSiweMessage({
    domain: location.host,
    address: getAddress(address),
    statement: SIGN_STATEMENT,
    uri: location.origin,
    version: '1',
    chainId: CHAIN.id,
    nonce: signNonce(address),
    issuedAt: ISSUED_AT,
  });
}

/** Domain tag for the display address, so it is never a slice of keccak256(signature) itself. */
const DISPLAY_TAG = toHex(`velum:private-account:${SCHEME_VERSION}:display-address`);

/**
 * velum1 + 36 hex characters of keccak256(tag || keccak256(signature)). Phase 4 derives keys from
 * the signature under other tags, so the public display address reveals nothing about them.
 */
export function derivePrivateAddress(signature: Hex): string {
  const seed = keccak256(signature);
  return 'velum1' + keccak256(concat([DISPLAY_TAG, seed])).slice(2, 38);
}

export { isPrivateAddress } from './store';

export type PublicAddressCheck = 'ok' | 'format' | 'checksum' | 'zero';

/** EIP-55 aware: mixed-case addresses must match their checksum (audit web I2). */
export function checkPublicAddress(s: string): PublicAddressCheck {
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return 'format';
  // All-lowercase and all-uppercase carry no checksum (EIP-55); mixed case must match it.
  const hex = s.slice(2);
  const unchecked = hex === hex.toLowerCase() || hex === hex.toUpperCase();
  if (!isAddress(unchecked ? s.toLowerCase() : s, { strict: true })) return 'checksum';
  if (s.toLowerCase() === zeroAddress) return 'zero';
  return 'ok';
}

export const isPublicAddress = (s: string) => checkPublicAddress(s) === 'ok';
