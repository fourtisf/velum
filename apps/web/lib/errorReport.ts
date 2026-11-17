'use client';
/**
 * Uncaught errors in the browser go to the API (POST /v1/client-errors, apps/api/src/routes/client-errors.ts) so a broken
 * release shows up before users report it. Production builds only; at most 10 reports per page load, each distinct
 * message once. No wallet address, key, signature or other long hex is sent (scrubbed here, and again on the server), no
 * query string, no identity. Noise is dropped: browser extensions, ResizeObserver warnings, wallet rejections, aborted
 * requests.
 */
import { ENV } from './env';

const MAX_PER_LOAD = 10;
const sent = new Set<string>();
let count = 0;

export const scrubText = (s: string): string => s.replace(/0x[0-9a-fA-F]{16,}/g, '0x…').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '…@…');

/** Whether an error is noise not worth a report (pure, for tests). */
export function isNoise(message: string, stack: string): boolean {
  return (
    /chrome-extension:|moz-extension:|safari-web-extension:/.test(stack) ||
    /ResizeObserver loop|User rejected|user rejected|denied transaction|AbortError|The operation was aborted|Load failed|NetworkError when attempting/i.test(message)
  );
}

/** The report body for an error (pure, for tests). */
export function reportBody(kind: 'error' | 'unhandledrejection' | 'boundary', err: unknown, path: string, release: string) {
  const e = err as { message?: unknown; stack?: unknown } | null;
  const message = scrubText(String((e && typeof e === 'object' ? e.message : err) ?? 'Unknown error')).slice(0, 500) || 'Unknown error';
  const stack = scrubText(typeof e?.stack === 'string' ? e.stack : '').slice(0, 4000);
  return { kind, message, stack, path: path.split(/[?#]/)[0]!.slice(0, 200), release: release.replace(/[^\w.-]/g, '').slice(0, 40) };
}

export function reportError(kind: 'error' | 'unhandledrejection' | 'boundary', err: unknown) {
  if (process.env.NODE_ENV !== 'production' || typeof window === 'undefined') return;
  const body = reportBody(kind, err, window.location.pathname, process.env.NEXT_PUBLIC_RELEASE ?? '');
  if (isNoise(body.message, body.stack) || sent.has(body.message) || count >= MAX_PER_LOAD) return;
  sent.add(body.message);
  count++;
  void fetch(`${ENV.apiUrl}/v1/client-errors`, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined);
}

let installed = false;
/** Listens for uncaught errors and unhandled promise rejections (once). */
export function installErrorReporting() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => reportError('error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError('unhandledrejection', e.reason));
}
