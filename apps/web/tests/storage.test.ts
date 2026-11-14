/** Browser storage rules: legacy cleanup (audit round 2, N5), sessions and account fingerprints. */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'testnet';
});

import { CHAIN } from '@velum/config';
import {
  dropLegacyStorage,
  forgetSession,
  isLegacyKey,
  recallAccountFingerprint,
  recallSession,
  rememberAccountFingerprint,
  rememberSession,
} from '@/lib/store';
import { installStorage } from './helpers';

const A = '0x00000000000000000000000000000000000000aa';
const P = 'velum1' + 'c'.repeat(36);

describe('legacy cleanup (N5)', () => {
  it('removes v1 sessions and ledgers and v2 sessions on every chain; keeps what this build reads', () => {
    const st = installStorage({
      'velum:session:v1': JSON.stringify({ [A]: 'velum1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      [`velum:demo:v1:${A}`]: '{"priv":{"USDG":"12500000000000000000000n"}}',
      'velum:demo:v1:0x00000000000000000000000000000000000000bb': '{}',
      'velum:session:v2:46630': '{}',
      'velum:session:v2:4663': '{}',
      [`velum:demo:v2:46630:${A}`]: '{"priv":{}}',
      [`velum:demo:v2:4663:${A}`]: '{"priv":{}}',
      'velum:session:v3:46630': '{}',
      'velum:signer:v1:46630': '{}',
      'velum:acct:v1:46630': '{}',
      'wagmi.store': '{}',
      'unrelated:key': 'keep',
    });
    dropLegacyStorage();
    const keys = Array.from({ length: st.length }, (_, i) => st.key(i)!).sort();
    expect(keys).toEqual(
      ['unrelated:key', 'velum:acct:v1:46630', `velum:demo:v2:4663:${A}`, `velum:demo:v2:46630:${A}`, 'velum:session:v3:46630', 'velum:signer:v1:46630', 'wagmi.store'].sort(),
    );
  });

  it('classifies keys', () => {
    expect(isLegacyKey('velum:session:v1')).toBe(true);
    expect(isLegacyKey('velum:demo:v1:0xabc')).toBe(true);
    expect(isLegacyKey('velum:session:v2:1')).toBe(true);
    expect(isLegacyKey('velum:demo:v2:1:0xabc')).toBe(false);
    expect(isLegacyKey('velum:session:v3:1')).toBe(false);
  });

  it('survives storage that throws', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      get length(): number {
        throw new Error('blocked');
      },
    };
    expect(() => dropLegacyStorage()).not.toThrow();
  });
});

describe('sessions and fingerprints', () => {
  it('a session holds only an exactly formatted private address', () => {
    const st = installStorage();
    rememberSession(A.toUpperCase().replace('0X', '0x'), P);
    expect(recallSession(A)).toBe(P);
    st.setItem(`velum:session:v3:${CHAIN.id}`, JSON.stringify({ [A]: 'velum1zzzzzzzzzz' }));
    expect(recallSession(A)).toBeNull();
    rememberSession(A, P);
    forgetSession(A);
    expect(recallSession(A)).toBeNull();
  });

  it('the account fingerprint outlives a disconnect', () => {
    installStorage();
    rememberSession(A, P);
    rememberAccountFingerprint(A, 'f'.repeat(32));
    forgetSession(A);
    expect(recallAccountFingerprint(A)).toBe('f'.repeat(32));
    rememberAccountFingerprint(A, 'not-a-fingerprint');
    expect(recallAccountFingerprint(A)).toBeNull();
  });
});
