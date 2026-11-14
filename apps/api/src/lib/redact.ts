/**
 * Removes credentials, paths and query strings from every URL in a message before it is logged or
 * printed. Provider RPC URLs carry API keys in the path; DATABASE_URL and REDIS_URL carry passwords.
 * "https://host/v2/KEY" becomes "https://host/…", "redis://:pw@127.0.0.1:6379/5" becomes
 * "redis://127.0.0.1:6379/…". Anything that does not parse as a URL becomes "[url]".
 */
export const redactUrls = (msg: string): string =>
  msg.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, (u) => {
    try {
      const url = new URL(u);
      return url.host ? `${url.protocol}//${url.host}/…` : '[url]';
    } catch {
      return '[url]';
    }
  });
