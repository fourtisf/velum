/** JSON-lines logger for PM2. Never log keys or user data: every string value passes through redact(). */
import { redact } from './redact';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
/** LOG_LEVEL takes pino's names (like the API): fatal and trace map to error and debug, silent logs nothing. */
const ALIASES: Record<string, number> = { ...ORDER, fatal: ORDER.error, trace: ORDER.debug, silent: Infinity };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const clean = (data: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
  data && Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? redact(v) : v]));

export function createLogger(level: string = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')): Logger {
  const min = ALIASES[level] ?? ORDER.info;
  const write = (lvl: Level, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: lvl, msg: redact(msg), ...clean(data) });
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}
