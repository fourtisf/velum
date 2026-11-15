import { urlSecrets } from '@velum/config';

/**
 * Removes credentials, paths and query strings from every URL in a message before it is logged or
 * printed. Provider RPC URLs carry API keys in the path; DATABASE_URL and REDIS_URL carry passwords.
 * Only the scheme and host[:port] are kept: "https://host/v2/KEY" becomes "https://host/…" and
 * "redis://:pw@127.0.0.1:6379/5" becomes "redis://127.0.0.1:6379/…".
 *
 * A URL runs from "scheme://" to the next whitespace, double quote, backtick, "<" or ">". Its userinfo
 * is everything up to the LAST "@" in it, whatever characters the password holds (' ( ) ! * ~ @ : are
 * left as they are by encodeURIComponent, and a hand-written .env may hold anything), so no part of a
 * password is printed (audit R2-L2). When "/", "?" or "#" comes before that "@", the host cannot be
 * told apart from the password and the whole URL becomes "[url]"; so does anything without a host.
 * Closing punctuation right after the URL (")", ",", ".", ";", "'", "]") is kept for readability.
 * Keep in sync with apps/api/src/lib/redact.ts.
 *
 * URL parsing alone cannot see every secret: a password with a space, quote, "<", ">" or backtick ends
 * the URL early and the rest of it is printed, and a key may appear outside any URL. redact() therefore
 * first removes the actual secret values this process was given (audit L-6): PROXY_SECRET, every
 * *_PRIVATE_KEY and *SECRET* variable, ALERT_WEBHOOK_URL, the passwords inside DATABASE_URL and
 * REDIS_URL (as written and decoded) and the path and query parts of RPC_URL and RPC_URL_SEND, as plain
 * substrings.
 */
const URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/([^\s"<>`]*)/gi;
const HOST_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::\d{1,5})?/i;
const TAIL_RE = /[)\],.;']+$/;

export const redactUrls = (msg: string): string =>
  msg.replace(URL_RE, (_all, scheme: string, rest: string) => {
    const at = rest.lastIndexOf('@');
    const afterAt = rest.slice(at + 1);
    const tail = TAIL_RE.exec(afterAt)?.[0] ?? '';
    if (at >= 0 && /[/?#]/.test(rest.slice(0, at))) return `[url]${tail}`;
    const host = HOST_RE.exec(afterAt)?.[0];
    return host ? `${scheme.toLowerCase()}://${host.toLowerCase()}/…${tail}` : `[url]${tail}`;
  });

/** Values shorter than this are not treated as secrets (they would match ordinary words). */
const MIN_SECRET = 6;
const SECRET_NAME = /(^PROXY_SECRET$|_PRIVATE_KEY$|SECRET|PASSWORD|^ALERT_WEBHOOK_URL$|^DEPLOYER_KEY$)/;

/** The secret values in `env`, longest first, so a secret that contains another is removed whole. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(env)) {
    if (!v || !SECRET_NAME.test(k)) continue;
    out.add(v.trim());
  }
  for (const k of ['DATABASE_URL', 'REDIS_URL']) for (const s of urlSecrets(env[k])) out.add(s);
  // A provider RPC URL carries its key in the path or query: every segment of them is secret (RPC_URL_SEND too).
  for (const k of ['RPC_URL', 'RPC_URL_SEND']) {
    const rpc = /^https?:\/\/[^/?#]+([^#]*)/i.exec(env[k] ?? '')?.[1] ?? '';
    for (const part of rpc.split(/[/?&=]/)) out.add(part);
  }
  return [...out].filter((s) => s.length >= MIN_SECRET).sort((a, b) => b.length - a.length);
}

let processSecrets: string[] | null = null;

/** Removes the secret values of `env` (default: this process's environment), then every URL's credentials. */
export function redact(msg: string, env: NodeJS.ProcessEnv = process.env): string {
  const secrets = env === process.env ? (processSecrets ??= secretValues(process.env)) : secretValues(env);
  let out = msg;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join('***');
  return redactUrls(out);
}
