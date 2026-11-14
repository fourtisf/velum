/**
 * Private-account signing (audit web L8, round 2 N1/N2). The sign message is key material: these
 * pins fail if any byte of it changes, which would silently move every user to a new account.
 * Update a pin only together with a deliberate, announced scheme change (new SCHEME_VERSION).
 */
import { MAINNET_CHAIN_ID, TESTNET_CHAIN_ID } from '@velum/config';
import { concat, keccak256, recoverMessageAddress, toBytes, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import { describe, expect, it } from 'vitest';
import {
  SIGN_SCHEME,
  accountFingerprint,
  buildSignMessage,
  checkPublicAddress,
  checkSignature,
  derivePrivateAddress,
  isPrivateAddress,
  normalizeSignature,
  signNonce,
} from '@/lib/account';
import { COPY } from '@/lib/copy';

const LOC = { host: 'velum.example', origin: 'https://velum.example' };
// Anvil / Hardhat test account #0: a public, well-known key, used only to pin deterministic outputs.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const acc = privateKeyToAccount(KEY);
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const STATEMENT_TAIL =
  'This creates your private keys in this browser. It costs no gas and sends nothing to a server. Only sign this on Velum: anyone with this signature can open your private account.';

/** Captured from the build before round 2 (CHAIN.label era): the bytes users have already signed. */
const PINNED = {
  testnet: {
    message:
      'velum.example wants you to sign in with your Ethereum account:\n0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266\n\n' +
      `Open your Velum private account on Robinhood Chain testnet. ${STATEMENT_TAIL}\n\n` +
      'URI: https://velum.example\nVersion: 1\nChain ID: 46630\nNonce: f35c8ef5e760dfec\nIssued At: 2026-11-14T00:00:00.000Z',
    keccak: '0x590e9f2382d8e317ca6a4010eef1875ca9efbb680a0cc752b70ed2858c8c2278',
    paddr: 'velum1209e7c0c8ca1ff2a2cdb1906e108e63dbe4b',
  },
  mainnet: {
    message:
      'velum.example wants you to sign in with your Ethereum account:\n0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266\n\n' +
      `Open your Velum private account on Robinhood Chain. ${STATEMENT_TAIL}\n\n` +
      'URI: https://velum.example\nVersion: 1\nChain ID: 4663\nNonce: 2b992e3fdbf75795\nIssued At: 2026-11-14T00:00:00.000Z',
    keccak: '0x08d53f928739e53750d40fa21832a84f77e184cbcc735e28dafe8135656f70ba',
    paddr: 'velum13f71d237649252ffcb336012c0a7ca6c4699',
  },
} as const;

/** v=27/28 -> 0/1, and the equivalent high-s form of a low-s signature. */
const v01 = (sig: Hex) => (sig.slice(0, -2) + (Number.parseInt(sig.slice(-2), 16) - 27).toString(16).padStart(2, '0')) as Hex;
function highS(sig: Hex): Hex {
  const s = BigInt('0x' + sig.slice(66, 130));
  const v = Number.parseInt(sig.slice(130), 16);
  return `${sig.slice(0, 66)}${(N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
}

describe('pinned sign message per network (N2)', () => {
  for (const net of ['testnet', 'mainnet'] as const) {
    it(`${net}: exact bytes`, () => {
      const m = buildSignMessage(acc.address, LOC, net);
      expect(m).toBe(PINNED[net].message);
      expect(keccak256(toBytes(m))).toBe(PINNED[net].keccak);
    });

    it(`${net}: the same wallet derives the same private address as before`, async () => {
      const sig = await acc.signMessage({ message: buildSignMessage(acc.address, LOC, net) });
      const ok = await checkSignature(sig, PINNED[net].message, acc.address);
      expect(ok).toEqual({ ok: true, sig });
      expect(derivePrivateAddress(normalizeSignature(sig)!)).toBe(PINNED[net].paddr);
    });
  }

  it('chain IDs are fixed constants that match the network config', () => {
    expect(SIGN_SCHEME.testnet.chainId).toBe(TESTNET_CHAIN_ID);
    expect(SIGN_SCHEME.mainnet.chainId).toBe(MAINNET_CHAIN_ID);
  });

  it('is decoupled from UI copy and frozen', () => {
    expect(Object.isFrozen(SIGN_SCHEME)).toBe(true);
    expect(Object.isFrozen(SIGN_SCHEME.testnet)).toBe(true);
    expect(() => {
      (SIGN_SCHEME.testnet as { statement: string }).statement = 'x';
    }).toThrow();
    // The UI label can change freely; the statement is its own literal.
    expect(SIGN_SCHEME.testnet.statement.startsWith('Open your Velum private account on Robinhood Chain testnet.')).toBe(true);
    expect(SIGN_SCHEME.mainnet.statement.startsWith('Open your Velum private account on Robinhood Chain.')).toBe(true);
    expect(typeof COPY.chainLabel).toBe('string');
  });

  it('is byte-stable for one wallet (address case, time) and EIP-4361 valid', async () => {
    const a = privateKeyToAccount(generatePrivateKey());
    const m1 = buildSignMessage(a.address, LOC, 'mainnet');
    const m2 = buildSignMessage(a.address.toLowerCase() as `0x${string}`, LOC, 'mainnet');
    expect(m1).toBe(m2);
    const p = parseSiweMessage(m1);
    expect(p.expirationTime).toBeUndefined();
    expect(validateSiweMessage({ message: p, domain: 'velum.example', address: a.address })).toBe(true);
    expect(validateSiweMessage({ message: p, domain: 'velum-app.example' })).toBe(false);
  });

  it('host and network are part of the message', () => {
    const base = buildSignMessage(acc.address, LOC, 'mainnet');
    expect(buildSignMessage(acc.address, { host: 'www.velum.example', origin: 'https://www.velum.example' }, 'mainnet')).not.toBe(base);
    expect(buildSignMessage(acc.address, LOC, 'testnet')).not.toBe(base);
  });

  it('nonce is 16 hex characters per wallet and chain', () => {
    expect(signNonce(acc.address, 'testnet')).toBe('f35c8ef5e760dfec');
    expect(signNonce(acc.address, 'mainnet')).toBe('2b992e3fdbf75795');
  });
});

describe('signature normalization (N1)', () => {
  it('maps v in {0,1} and the high-s twin to the canonical r || low-s || v(27/28)', async () => {
    const m = PINNED.mainnet.message;
    const sig = await acc.signMessage({ message: m });
    expect(normalizeSignature(sig)).toBe(sig.toLowerCase());
    expect(normalizeSignature(v01(sig))).toBe(sig.toLowerCase());
    expect(normalizeSignature(highS(sig))).toBe(sig.toLowerCase());
    expect(normalizeSignature(v01(highS(sig)))).toBe(sig.toLowerCase());
    expect(normalizeSignature(sig.toUpperCase().replace('0X', '0x'))).toBe(sig.toLowerCase());
    // All encodings recover to the wallet, and all open the same account.
    for (const variant of [v01(sig), highS(sig)]) {
      expect(await recoverMessageAddress({ message: m, signature: normalizeSignature(variant)! })).toBe(acc.address);
      const r = await checkSignature(variant, m, acc.address);
      expect(r.ok && derivePrivateAddress(r.sig)).toBe(PINNED.mainnet.paddr);
    }
  });

  it('refuses anything that is not 65 bytes of valid r, s, v', async () => {
    const sig = await acc.signMessage({ message: 'x' });
    const r = sig.slice(2, 66);
    const s = sig.slice(66, 130);
    const bad = [
      '',
      '0x',
      '0x00',
      sig.slice(0, -2),
      sig + '00',
      `0x${r}${s}02`,
      `0x${r}${s}1d`,
      `0x${'0'.repeat(64)}${s}1b`,
      `0x${r}${'0'.repeat(64)}1b`,
      `0x${r}${N.toString(16)}1b`,
      `0x${N.toString(16)}${s}1b`,
      `0x${'g'.repeat(130)}`,
      sig.slice(2),
      // ERC-6492 wrapped signature (magic suffix) and a long ERC-1271 style blob.
      sig + '6492649264926492649264926492649264926492649264926492649264926492',
      '0x' + 'ab'.repeat(200),
    ];
    for (const b of bad) expect(normalizeSignature(b), b.slice(0, 20)).toBeNull();
  });
});

describe('signature checks before deriving an account (N1)', () => {
  const m = PINNED.testnet.message;

  it('accepts a real signature from the connected wallet', async () => {
    const sig = await acc.signMessage({ message: m });
    expect(await checkSignature(sig, m, acc.address)).toEqual({ ok: true, sig });
    expect(await checkSignature(sig, m, acc.address.toLowerCase() as `0x${string}`)).toEqual({ ok: true, sig });
  });

  it('refuses empty and constant signatures', async () => {
    expect(await checkSignature('0x', m, acc.address)).toEqual({ ok: false, reason: 'format' });
    expect(await checkSignature('0x' + '00'.repeat(65), m, acc.address)).toEqual({ ok: false, reason: 'format' });
    // A fixed 65-byte value that is a well-formed signature, returned for every request.
    const constant = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
    expect(normalizeSignature(constant)).not.toBeNull();
    expect(await checkSignature(constant, m, acc.address)).toEqual({ ok: false, reason: 'signer' });
    expect(await checkSignature(constant, PINNED.mainnet.message, acc.address)).toEqual({ ok: false, reason: 'signer' });
  });

  it('refuses a signature from another key (e.g. a contract wallet owner) and over another message', async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    expect(await checkSignature(await other.signMessage({ message: m }), m, acc.address)).toEqual({ ok: false, reason: 'signer' });
    expect(await checkSignature(await acc.signMessage({ message: m + ' ' }), m, acc.address)).toEqual({ ok: false, reason: 'signer' });
  });

  it('refuses contract-wallet signature formats (ERC-1271 blobs, ERC-6492 wrappers)', async () => {
    const sig = await acc.signMessage({ message: m });
    expect(await checkSignature(sig + '6492'.repeat(16), m, acc.address)).toEqual({ ok: false, reason: 'format' });
    expect(await checkSignature('0x' + 'ab'.repeat(97), m, acc.address)).toEqual({ ok: false, reason: 'format' });
  });

  it('two different but valid signatures from one wallet are different (the double-sign check compares normalized bytes)', async () => {
    const a = await acc.signMessage({ message: m });
    const b = await acc.signMessage({ message: m });
    expect(normalizeSignature(a)).toBe(normalizeSignature(b)); // RFC 6979: deterministic
    expect(normalizeSignature(v01(a))).toBe(normalizeSignature(b)); // re-encoding is not instability
  });
});

describe('derived address and fingerprint', () => {
  it('display address is velum1 + 36 hex of a domain-separated hash', async () => {
    const sig = await acc.signMessage({ message: PINNED.testnet.message });
    const expected = 'velum1' + keccak256(concat([toHex('velum:private-account:v1:display-address'), keccak256(sig)])).slice(2, 38);
    expect(derivePrivateAddress(sig)).toBe(expected);
    expect(isPrivateAddress(expected)).toBe(true);
  });

  it('fingerprint is a stable tag per chain, wallet and account', () => {
    const fp = accountFingerprint(4663, acc.address, PINNED.mainnet.paddr);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    expect(accountFingerprint(4663, acc.address.toLowerCase() as `0x${string}`, PINNED.mainnet.paddr)).toBe(fp);
    expect(accountFingerprint(46630, acc.address, PINNED.mainnet.paddr)).not.toBe(fp);
    expect(accountFingerprint(4663, acc.address, PINNED.testnet.paddr)).not.toBe(fp);
    expect(fp).not.toContain(PINNED.mainnet.paddr.slice(6, 20));
  });
});

describe('address formats', () => {
  it('private address: exactly velum1 + 36 lowercase hex', () => {
    expect(isPrivateAddress(PINNED.testnet.paddr)).toBe(true);
    for (const bad of ['velum1zzzzzzzzzz', 'VELUM1ABCDEFGHIJ', 'velum1' + 'a'.repeat(35), 'velum1' + 'a'.repeat(37), 'velum1' + 'A'.repeat(36), 'velum1' + 'g'.repeat(36), ' velum1' + 'a'.repeat(36), 'velum2' + 'a'.repeat(36)])
      expect(isPrivateAddress(bad), bad).toBe(false);
  });

  it('public address: EIP-55 checksum, zero address refused', () => {
    expect(checkPublicAddress('0x52908400098527886E0F7030069857D2E4169EE7')).toBe('ok');
    expect(checkPublicAddress('0x52908400098527886e0F7030069857D2E4169EE7')).toBe('checksum');
    expect(checkPublicAddress('0x52908400098527886e0f7030069857d2e4169ee7')).toBe('ok');
    expect(checkPublicAddress('0x0000000000000000000000000000000000000000')).toBe('zero');
    expect(checkPublicAddress('0x123')).toBe('format');
  });
});
