/**
 * The landing page's token contract address ("CA", owner request): only an exact EIP-55 checksummed
 * NEXT_PUBLIC_TOKEN_CA is shown and copied; anything else reads "Coming soon" and copies nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getAddress, type Address } from 'viem';
import { CA_COPY, ContractPill } from '@/components/landing/ContractPill';
import { VELUM_TOKEN_CA, caExplorerUrl, copyTokenCa, parseTokenCa, shortCa } from '@/lib/token-ca';

// A real checksummed address used only as test data (USDG on Robinhood Chain mainnet).
const LOWER = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const CA = getAddress(LOWER);
const html = (ca: Address | null) => renderToStaticMarkup(createElement(ContractPill, { ca }));

describe('parseTokenCa', () => {
  it('a correctly checksummed address is the CA', () => {
    expect(CA).not.toBe(LOWER); // mixed case
    expect(parseTokenCa(CA)).toBe(CA);
  });

  it('empty, malformed, unchecksummed or wrongly checksummed values are not set', () => {
    // One letter's case changed (first and last hex letter): a wrong checksum.
    const flipAt = (i: number) => CA.slice(0, i) + (CA[i] === CA[i]!.toUpperCase() ? CA[i]!.toLowerCase() : CA[i]!.toUpperCase()) + CA.slice(i + 1);
    const letters = [...CA.slice(2)].map((c, i) => (/[a-fA-F]/.test(c) ? i + 2 : -1)).filter((i) => i >= 0);
    const wrongCase = flipAt(letters[0]!);
    const flipped = flipAt(letters.at(-1)!);
    expect([wrongCase, flipped].every((v) => v !== CA && v.toLowerCase() === LOWER)).toBe(true);
    for (const v of [undefined, null, '', ' ', 'Coming soon', '0x', '0x123', LOWER, LOWER.toUpperCase().replace('0X', '0x'), wrongCase, flipped, ` ${CA}`, `${CA} `, CA.slice(2), CA + '0', 'javascript:alert(1)', 42])
      expect([v, parseTokenCa(v)]).toEqual([v, null]);
  });

  it('shortens to 0x1234…abcd and links to the Robinhood Chain mainnet explorer', () => {
    expect(shortCa(CA)).toBe(`${CA.slice(0, 6)}…${CA.slice(-4)}`);
    expect(caExplorerUrl(CA)).toBe(`https://robinhoodchain.blockscout.com/address/${CA}`);
  });
});

describe('ContractPill', () => {
  it('not set: "CA" and "Coming soon", a copy button announced as unavailable, no explorer link', () => {
    const h = html(null);
    expect(h).toContain('>CA<');
    expect(h).toContain(CA_COPY.soon);
    expect(h).toContain('aria-disabled="true"');
    expect(h).toContain(`title="${CA_COPY.soonTitle}"`);
    expect(h).not.toContain(' disabled=""'); // still focusable, not trapped
    expect(h).not.toContain('<a ');
    expect(h).not.toMatch(/0x[0-9a-fA-F]/);
  });

  it('set: the shortened address shown, the full one in its title and accessible name, copy and explorer link', () => {
    const h = html(CA);
    expect(h).toContain(shortCa(CA));
    expect(h).toContain(`title="${CA}"`);
    expect(h).toContain(`<span class="sr">${CA}</span>`);
    expect(h).toContain(`aria-label="Copy contract address ${CA}"`);
    expect(h).toContain(`href="https://robinhoodchain.blockscout.com/address/${CA}"`);
    expect(h).toContain('target="_blank"');
    expect(h).toContain('rel="noopener noreferrer"');
    expect(h).not.toContain(CA_COPY.soon);
    expect(h).not.toContain('aria-disabled');
  });

  it('copy wording: only "CA" and the toast, no price, return or sale claims', () => {
    const all = Object.values(CA_COPY).join(' ') + html(null) + html(CA);
    expect(all).not.toMatch(/\b(buy|sale|presale|price|return|profit|moon|launch(?:es|ing)? at)\b/i);
    expect(CA_COPY.copied).toBe('Contract address copied');
  });
});

describe('copyTokenCa', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('copies the full checksummed address with the Clipboard API', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyTokenCa(CA)).toBe(true);
    expect(writeText).toHaveBeenCalledWith(CA);
  });

  it('falls back to a hidden textarea when the Clipboard API is missing or refuses', async () => {
    const made: Array<{ value: string }> = [];
    const doc = {
      body: { appendChild: vi.fn() },
      createElement: () => {
        const el = { value: '', style: {}, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() };
        made.push(el);
        return el;
      },
      execCommand: vi.fn(() => true),
    };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) } });
    expect(await copyTokenCa(CA)).toBe(true);
    expect(made[0]!.value).toBe(CA);
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
  });

  it('never copies anything but a valid checksummed address', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    for (const v of [LOWER, 'Coming soon', shortCa(CA)]) expect(await copyTokenCa(v as Address)).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('NEXT_PUBLIC_TOKEN_CA at build time (lib/env)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  const envCa = async (v: string) => {
    vi.stubEnv('NEXT_PUBLIC_TOKEN_CA', v);
    vi.resetModules();
    return (await import('@/lib/env')).ENV.tokenCa;
  };

  it('a checksummed NEXT_PUBLIC_TOKEN_CA wins; empty, lowercase or invalid: the verified VELUM token', async () => {
    expect(await envCa(CA)).toBe(CA);
    for (const v of ['', LOWER, '0x1234']) expect(await envCa(v)).toBe(VELUM_TOKEN_CA);
  });

  it('the VELUM token address is correctly checksummed (owner-provided, verified on chain)', () => {
    expect(VELUM_TOKEN_CA).toBe('0xa9721E7ee2C84fa60c772a82B5021485a0d2C5Ec');
    expect(parseTokenCa(VELUM_TOKEN_CA)).toBe(VELUM_TOKEN_CA);
    expect(VELUM_TOKEN_CA.toLowerCase()).toBe('0xa9721e7ee2c84fa60c772a82b5021485a0d2c5ec');
  });
});
