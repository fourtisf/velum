/** Regression tests for audit R2-L2 (L7 incomplete): no part of a password may survive redaction. */
import { describe, expect, it } from 'vitest';
import { redactUrls } from './redact';

// Every character the review asked for, alone and together, raw and as encodeURIComponent leaves it.
const NASTY = ["'", ')', '(', '!', '*', '~', '@', ':', '/', '#', '?'];
const PASSWORDS = [...NASTY.map((c) => `ab${c}cdSECRETzz`), `p'a)s(s!w*o~r@d:x/y#z?SECRETzz`, `SECRETzz)`, `)SECRETzz`, `SECRETzz@`];

describe('R2-L2: redactUrls never prints any part of a password', () => {
  it.each(PASSWORDS)('raw password %j', (pw) => {
    for (const url of [`redis://:${pw}@127.0.0.1:6391/5`, `postgresql://velum:${pw}@127.0.0.1:5432/velum?schema=public`]) {
      const out = redactUrls(`Invalid API environment: ${url} (check .env)`);
      expect(out).not.toContain('SECRET');
      expect(out).not.toContain('zz');
      expect(out).toMatch(/^Invalid API environment: (redis:\/\/127\.0\.0\.1:6391\/…|postgresql:\/\/127\.0\.0\.1:5432\/…|\[url\]) \(check \.env\)$/);
    }
  });
  it.each(PASSWORDS)('encodeURIComponent(%j)', (pw) => {
    const out = redactUrls(`connect failed: redis://:${encodeURIComponent(pw)}@127.0.0.1:6391/5`);
    expect(out).toBe('connect failed: redis://127.0.0.1:6391/…');
  });
  it('keeps the host when the password is unambiguous, even with @ and :', () => {
    expect(redactUrls("redis://:r2'pw)x@127.0.0.1:6391/5")).toBe('redis://127.0.0.1:6391/…');
    expect(redactUrls('postgresql://velum:abc)defghijkl@127.0.0.1:5432/velum')).toBe('postgresql://127.0.0.1:5432/…');
    expect(redactUrls('redis://u:p@ss:w@rd@[::1]:6379/5')).toBe('redis://[::1]:6379/…');
  });
  it('drops the whole URL when "/", "?" or "#" precedes the last "@"', () => {
    expect(redactUrls('redis://:a/b@127.0.0.1:6379/5')).toBe('[url]');
    expect(redactUrls('https://host/path?mail=a@b.example')).toBe('[url]');
  });
  it('still strips keys, paths and queries, and keeps surrounding text', () => {
    expect(redactUrls('see https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY123 now')).toBe('see https://robinhood-mainnet.g.alchemy.com/… now');
    expect(redactUrls('(https://user:pw@rpc.example.com:8545/?key=abc)')).toBe('(https://rpc.example.com:8545/…)');
    expect(redactUrls("'redis://:pw@127.0.0.1:6379/5', next")).toBe("'redis://127.0.0.1:6379/…', next");
    expect(redactUrls('a redis://:x@h1:1/0 and https://h2/KEY b')).toBe('a redis://h1:1/… and https://h2/… b');
    expect(redactUrls('file:///etc/passwd')).toBe('[url]');
    expect(redactUrls('no urls here')).toBe('no urls here');
  });
});
