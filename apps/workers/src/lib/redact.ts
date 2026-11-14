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
