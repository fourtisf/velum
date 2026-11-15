/**
 * Test helpers (not a test file): privacy and price-source claims the web must not make while the
 * privacy layer is simulated (owner decision of 2026-11-15, audit web F2/F12/F13), on either network.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Phrases that state a simulated privacy feature, a key, or a price source as fact. */
export const PRIVACY_CLAIMS: RegExp[] = [
  /Private perps are live/i,
  /with (?:your )?balances?, positions and P&L encrypted end to end/i,
  /decrypted on this device/i,
  /\bTo prove a trade in your browser/,
  /Generating proof in your browser/i,
  /Relayer submitting proof/i,
  /The relayer pays gas/i,
  /Locking margin in a private note/i,
  /Locking backing in a private note/i,
  /Creating an encrypted note/i,
  /Only they can read it/i,
  /creat\w* your private keys/i,
  /removes your keys/i,
  /\b1\.8s\b/,
  /^Size, side and entry stay encrypted/m,
  /(?:^|[.'"`] ?)Size, side and entry stay encrypted/,
  /(?:^|[.'"`>] ?)Pool reserves (?:and your trade stay|are) private/,
  /Live prices from Robinhood/i,
  /Live Robinhood Chain prices/i,
  /tokeni[sz]ed (?:stocks|equities)/i,
  /Last thing the public chain saw/i,
  /What the public chain sees/i,
  /Everything below is decrypted/i,
  // DV-F3: token issuers can freeze their tokens, and the contracts have a price-relay key and an
  // optional guardian, so neither "nobody can freeze" nor "no admin keys" is true.
  /nobody can freeze/i,
  /\bno admin keys?\b/i,
  />\s*admin keys\s*</,
  // Final audit W-07: a static line cannot know whether prices are live (closed, stale, API down).
  /Prices are live/i,
];

export const claimsIn = (s: string): string[] => PRIVACY_CLAIMS.filter((re) => re.test(s)).map(String);

/** The plain-string values of a copy object (functions left out). */
export const strings = (o: object): string[] => Object.values(o as Record<string, unknown>).filter((v): v is string => typeof v === 'string');

const WEB = fileURLToPath(new URL('..', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

/**
 * Every claim found in the web's own source (app, components, lib), as "file: /pattern/". The one
 * allowed exception is the sign-in message in lib/account.ts: it is hashed into each user's demo
 * address, so changing its words would give existing users a new address; the UI around it says
 * what really happens instead.
 */
export function claimsInSource(): string[] {
  const out: string[] = [];
  for (const f of ['app', 'components', 'lib'].flatMap((d) => files(join(WEB, d)))) {
    let src = readFileSync(f, 'utf8');
    if (f.endsWith(join('lib', 'account.ts'))) src = src.replace('This creates your private keys in this browser. ', '');
    for (const c of claimsIn(src)) out.push(`${relative(WEB, f)}: ${c}`);
  }
  return out;
}
