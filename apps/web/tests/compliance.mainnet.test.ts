/**
 * Terms, risk, the perps statement and error reports: the legal texts say what Velum is (independent, non-custodial, not
 * affiliated with Robinhood) and where perps are not offered; the statement is kept per wallet and version; error reports
 * carry no address, key, email or query string and skip noise.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

import { isNoise, reportBody, scrubText } from '@/lib/errorReport';
import { usePerpsTerms } from '@/lib/geo';
import { LEGAL_VERSION, PERPS_RESTRICTED, RISKS, TERMS } from '@/lib/legal';

const text = (s: Array<{ h: string; p: string[] }>) => s.map((x) => `${x.h} ${x.p.join(' ')}`).join(' ');

describe('legal texts', () => {
  it('the terms say Velum is independent, non-custodial, not advice, and where perps are not offered', () => {
    const t = text(TERMS);
    expect(t).toMatch(/not affiliated with Robinhood/);
    expect(t).toMatch(/never holds your funds or your keys/);
    expect(t).toMatch(/never withdraw/);
    expect(t).toMatch(/Nothing on Velum is investment, legal or tax advice/);
    expect(t).toMatch(/United States/);
    expect(PERPS_RESTRICTED).toMatch(/United States.*Cuba.*Iran.*North Korea.*Syria/);
    expect(LEGAL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the risk disclosure covers leverage, liquidation, funding, Stock Tokens, bridges and prices', () => {
    const r = text(RISKS);
    for (const w of [/liquidated/, /Funding/, /are not the shares/, /Relay/, /oracles|Prices come from/, /recovery phrase/]) expect(r).toMatch(w);
  });
});

describe('perps statement', () => {
  it('is kept per wallet (case-insensitive) once accepted', () => {
    const a = '0xAbCdEf0000000000000000000000000000000001';
    expect(usePerpsTerms.getState().isAccepted(a)).toBe(false);
    usePerpsTerms.getState().accept(a);
    expect(usePerpsTerms.getState().isAccepted(a.toLowerCase())).toBe(true);
    expect(usePerpsTerms.getState().isAccepted('0x0000000000000000000000000000000000000002')).toBe(false);
  });
});

describe('error reports', () => {
  it('scrub addresses, keys, signatures and emails; drop the query string', () => {
    const b = reportBody('error', new Error(`boom for 0x92ef4c8d8df09a9ae7ed9a12409bc9a84fb70e7b by me@example.com`), '/app/trade/TSLA?ref=x#y', 'v1.2+abc');
    expect(b.message).toBe('boom for 0x… by …@…');
    expect(b.path).toBe('/app/trade/TSLA');
    expect(b.release).toBe('v1.2abc');
    expect(b.kind).toBe('error');
    expect(scrubText('sig 0x' + 'ab'.repeat(65))).toBe('sig 0x…');
    expect(reportBody('unhandledrejection', 'plain string', '/', '').message).toBe('plain string');
  });

  it('skips noise: extensions, ResizeObserver, wallet rejections, aborted requests', () => {
    expect(isNoise('x', 'at chrome-extension://abc/inpage.js:1:1')).toBe(true);
    expect(isNoise('ResizeObserver loop completed with undelivered notifications.', '')).toBe(true);
    expect(isNoise('User rejected the request.', '')).toBe(true);
    expect(isNoise('AbortError: The operation was aborted.', '')).toBe(true);
    expect(isNoise('Cannot read properties of undefined', 'at app.js:1:1')).toBe(false);
  });
});
