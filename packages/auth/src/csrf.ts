/**
 * The synchronizer token of the BFFs' forms (docs/README.md §9, "CSRF"): the third layer, after the session
 * cookie's `SameSite=Lax` and the origin check of `assertSameOrigin`, for the browsers and proxies that strip
 * `Origin` and `Sec-Fetch-Site`. Every form carries it as a hidden field named `CSRF_FIELD`, and every handler
 * of a form verifies it against the session before calling an API. It is derived, not stored: the HMAC-SHA256
 * of the session ID keyed with `SESSION_SECRET`, so it is a secret of the session that is not the session ID
 * (the synchronizer pattern of the OWASP cheat sheet, with the HMAC of its signed double-submit cookie but no
 * cookie and no random value, since the token is verified against the session), it rotates with the session,
 * and no field is added to the store. Comparison is constant-time.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Session } from './session';

/** The name of the hidden field every form carries. */
export const CSRF_FIELD = 'csrf_token';

/** The token of the session: `base64url(HMAC-SHA256(secret, "csrf:" + session ID))`. */
export function csrfTokenOf(session: Pick<Session, 'id'>, secret: string): string {
  return createHmac('sha256', secret).update(`csrf:${session.id}`).digest('base64url');
}

/** Whether `presented` (a form field as read: a string, a file, or nothing) is the session's token. */
export function verifyCsrfToken(
  session: Pick<Session, 'id'>,
  secret: string,
  presented: unknown,
): boolean {
  if (typeof presented !== 'string') return false;
  const expected = Buffer.from(csrfTokenOf(session, secret), 'utf8');
  const given = Buffer.from(presented, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
