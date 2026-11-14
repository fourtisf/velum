/**
 * Private account (Phase 2 stand-in). One wallet signature over a fixed message is hashed in the
 * browser into a display private address. The signature stays in memory for this call only and is
 * never stored, cached or sent anywhere. Phase 4 replaces this with HKDF key derivation in @velum/sdk.
 *
 * The message is EIP-4361 (Sign-In with Ethereum) shaped (audit web L8), so wallets show it as a
 * sign-in for this site and warn when the domain does not match the page asking for it. It is not a
 * login: no server ever sees or checks it. It is key material, so it must be byte-for-byte the same
 * every time the same wallet signs on this site, or the wallet would open a different account:
 *  - domain = window.location.host, URI = window.location.origin;
 *  - the statement and chain ID are fixed constants per network below, never UI copy (audit round 2,
 *    N2): tests/account.test.ts pins the exact bytes, so a copy edit cannot silently move accounts;
 *  - Nonce is not random: it is derived from the scheme version, chain and wallet address. A random
 *    nonce protects a login against replay; here there is nothing to replay into, and a signature
 *    holder already has the account, which is what the statement warns about;
 *  - Issued At is fixed to the date this scheme (v1) was defined, for the same reason.
 * Changing any of these (including serving the app from another host) changes every derived account,
 * so the canonical host must stay fixed (redirect www and other aliases in Nginx).
 *
 * Only a plain 65-byte ECDSA signature that recovers to the connected wallet is accepted, and it is
 * hashed in one canonical form (r || low-s || v in {27, 28}) so that wallets encoding the same
 * signature differently still open the same account (audit round 2, N1). Contract wallets (ERC-1271,
 * ERC-6492) are refused for now: supporting them is a later, deliberate step.
 */
import { NETWORK, type NetworkName } from '@velum/config';
import { concat, getAddress, isAddress, keccak256, recoverMessageAddress, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';

export const SCHEME_VERSION = 'v1';
const ISSUED_AT = new Date('2026-11-14T00:00:00.000Z');

const STATEMENT = (network: string) =>
  `Open your Velum private account on ${network}. This creates your private keys in this browser. ` +
  'It costs no gas and sends nothing to a server. Only sign this on Velum: anyone with this signature can open your private account.';

/**
 * What the wallet signs, per network. Frozen: editing a value here moves every account on that
 * network. Single-line statements in the EIP-4361 charset.
 */
export const SIGN_SCHEME: Readonly<Record<NetworkName, { chainId: number; statement: string }>> = Object.freeze({
  testnet: Object.freeze({ chainId: 46630, statement: STATEMENT('Robinhood Chain testnet') }),
  mainnet: Object.freeze({ chainId: 4663, statement: STATEMENT('Robinhood Chain') }),
});

/** The statement for the network this build targets. */
export const SIGN_STATEMENT = SIGN_SCHEME[NETWORK].statement;

/** Deterministic nonce: 16 hex characters, unique per scheme version, chain and wallet. */
export function signNonce(address: Address, network: NetworkName = NETWORK): string {
  return keccak256(toHex(`velum:private-account:${SCHEME_VERSION}:nonce:${SIGN_SCHEME[network].chainId}:${address.toLowerCase()}`)).slice(2, 18);
}

/** The exact message the wallet signs. Browser only by default (reads window.location). */
export function buildSignMessage(address: Address, location: Pick<Location, 'host' | 'origin'> = window.location, network: NetworkName = NETWORK): string {
  const scheme = SIGN_SCHEME[network];
  return createSiweMessage({
    domain: location.host,
    address: getAddress(address),
    statement: scheme.statement,
    uri: location.origin,
    version: '1',
    chainId: scheme.chainId,
    nonce: signNonce(address, network),
    issuedAt: ISSUED_AT,
  });
}

/* ---------- signature checks (audit round 2, N1) ---------- */

/** secp256k1 group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N >> 1n;
const hex32 = (x: bigint) => x.toString(16).padStart(64, '0');

/**
 * The one canonical form of a 65-byte secp256k1 signature: r || s || v with s in the lower half of
 * the curve order and v in {27, 28}. Wallets that return v in {0, 1}, or the equivalent high-s
 * signature, map to the same bytes. null when it is not 65 bytes of valid r, s and v (empty,
 * truncated, ERC-1271 / ERC-6492 contract-wallet signatures, r or s out of range).
 */
export function normalizeSignature(sig: string): Hex | null {
  if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return null;
  const r = BigInt('0x' + sig.slice(2, 66));
  let s = BigInt('0x' + sig.slice(66, 130));
  let v = Number.parseInt(sig.slice(130, 132), 16);
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) return null;
  if (r === 0n || r >= N || s === 0n || s >= N) return null;
  if (s > HALF_N) {
    // (r, n - s) with the other recovery bit is the same signature (EIP-2 malleability).
    s = N - s;
    v = v === 27 ? 28 : 27;
  }
  return `0x${hex32(r)}${hex32(s)}${v.toString(16)}`;
}

export type SignatureCheck =
  | { ok: true; sig: Hex }
  /** format: not a plain 65-byte signature (empty, constant junk, contract wallet). signer: recovers to another address. */
  | { ok: false; reason: 'format' | 'signer' };

/**
 * Accepts only a 65-byte ECDSA signature over `message` that recovers to `address`, and returns it
 * normalized. Empty and constant signatures fail here: they don't recover to the connected wallet.
 */
export async function checkSignature(sig: string, message: string, address: Address): Promise<SignatureCheck> {
  const norm = normalizeSignature(sig);
  if (!norm) return { ok: false, reason: 'format' };
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message, signature: norm });
  } catch {
    return { ok: false, reason: 'signer' };
  }
  return signer.toLowerCase() === address.toLowerCase() ? { ok: true, sig: norm } : { ok: false, reason: 'signer' };
}

/** Domain tag for the display address, so it is never a slice of keccak256(signature) itself. */
const DISPLAY_TAG = toHex(`velum:private-account:${SCHEME_VERSION}:display-address`);

/**
 * velum1 + 36 hex characters of keccak256(tag || keccak256(signature)). Phase 4 derives keys from
 * the signature under other tags, so the public display address reveals nothing about them.
 * Pass a signature that checkSignature accepted (normalized).
 */
export function derivePrivateAddress(signature: Hex): string {
  const seed = keccak256(signature);
  return 'velum1' + keccak256(concat([DISPLAY_TAG, seed])).slice(2, 38);
}

/**
 * What this browser remembers about a wallet's account, so a later signature that opens a different
 * account can be flagged (audit round 2, N1): a tagged hash, never the private address itself.
 */
export function accountFingerprint(chainId: number, wallet: Address, paddr: string): string {
  return keccak256(toHex(`velum:private-account:${SCHEME_VERSION}:fingerprint:${chainId}:${wallet.toLowerCase()}:${paddr}`)).slice(2, 34);
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
