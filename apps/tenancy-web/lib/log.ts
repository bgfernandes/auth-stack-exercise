/**
 * The app's log: one JSON line per event, `warn` on stderr and `info` on stdout, the way the containers and
 * Tilt collect them. Nothing here redacts: a caller logs identifiers and outcomes, never a token, a session ID,
 * or a cookie (CLAUDE.md), and anything that comes from `@auth-stack/auth` went through its `redact` first.
 */
import { type AuthLogger } from '@auth-stack/auth';

export interface AppLogger extends AuthLogger {
  info(event: string, fields?: Record<string, unknown>): void;
}

export const log: AppLogger = {
  info: (event, fields) => {
    console.log(JSON.stringify({ level: 'info', event, ...fields }));
  },
  warn: (event, fields) => {
    console.warn(JSON.stringify({ level: 'warn', event, ...fields }));
  },
};
