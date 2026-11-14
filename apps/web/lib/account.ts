/**
 * Private account (Phase 2 stand-in). One wallet signature over a fixed message is hashed in the
 * browser into a display private address. The signature stays in memory for this call only and is
 * never stored or sent anywhere. Phase 4 replaces this with HKDF key derivation in @velum/sdk.
 */
import { keccak256, type Hex } from 'viem';

export const SIGN_MESSAGE = [
  'Velum private account',
  '',
  'Sign to open your private account on Robinhood Chain testnet.',
  'This creates your private keys in this browser. It costs no gas and sends nothing to a server.',
  '',
  'Only sign this message on Velum. Anyone with this signature can open your private account.',
  '',
  'Version: 1',
].join('\n');

export function derivePrivateAddress(signature: Hex): string {
  return 'velum1' + keccak256(signature).slice(2, 38);
}

export const isPrivateAddress = (s: string) => /^velum1[0-9a-z]{10,}$/i.test(s);
export const isPublicAddress = (s: string) => /^0x[0-9a-f]{40}$/i.test(s);
