/**
 * The login stash: `state`, `nonce`, and the PKCE verifier of a login in progress, kept between the redirect to
 * the authorization endpoint and the callback in a signed, short-lived cookie (docs/README.md §4.4 step 1). The
 * signature (HMAC-SHA256 with `SESSION_SECRET`) means the callback trusts only a stash the app itself issued;
 * the expiry bounds how long a started login stays usable.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { AuthError } from './errors';

export interface LoginStash {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Epoch milliseconds after which the stash is refused. */
  expiresAt: number;
}

/** Ten minutes: long enough for a registration or an MFA enrolment, short enough to bound a leaked stash. */
export const STASH_LIFETIME_SECONDS = 600;

export const MIN_SECRET_LENGTH = 32;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** `<base64url(json)>.<base64url(hmac)>`, the value of the stash cookie. */
export function sealStash(stash: LoginStash, secret: string): string {
  const payload = Buffer.from(JSON.stringify(stash), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** The stash behind a cookie value; throws `no_login_in_progress` when it does not verify, `login_expired` when it is too old. */
export function openStash(value: string | undefined, secret: string, now: number): LoginStash {
  if (!value) throw new AuthError('no_login_in_progress', 'no login stash cookie');
  const dot = value.lastIndexOf('.');
  if (dot === -1) throw new AuthError('no_login_in_progress', 'malformed login stash');
  const payload = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(payload, secret), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new AuthError('no_login_in_progress', 'login stash signature does not verify');
  }
  let stash: unknown;
  try {
    stash = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (error) {
    throw new AuthError('no_login_in_progress', 'login stash is not JSON', { cause: error });
  }
  if (!isStash(stash))
    throw new AuthError('no_login_in_progress', 'login stash has the wrong shape');
  if (stash.expiresAt <= now) throw new AuthError('login_expired', 'login stash expired');
  return stash;
}

function isStash(value: unknown): value is LoginStash {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.state === 'string' &&
    typeof v.nonce === 'string' &&
    typeof v.codeVerifier === 'string' &&
    typeof v.expiresAt === 'number'
  );
}
