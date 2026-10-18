/**
 * The back-channel logout sink (docs/README.md §4.4 step 6; OpenID Connect Back-Channel Logout 1.0): the IdP
 * posts a logout token, server to server, when the user's IdP session ends, and the sink removes every session
 * of ours that the token names. Unlike `logout`, there is no browser here: no cookie to read or clear, no
 * `Origin` to check, and no redirect in any case (§2.8); the signed token is the whole authentication of the
 * request. `200` once the sessions are gone (also when none matched: the IdP learns nothing from the count),
 * `400` with an OAuth-style error body for a request without a valid token, and a thrown error, so a `500`, when
 * the store fails, which the IdP may treat as "retry later" where a `400` is final. Both answers carry
 * `Cache-Control: no-store`. A replayed token can only delete what its first delivery deleted, so no `jti`
 * cache is kept.
 */
import { AuthError } from './errors';
import { redact, type AuthLogger } from './redact';

import type { OidcClient } from './oidc';
import type { SessionStore } from './session';

export interface BackchannelLogoutOptions {
  client: Pick<OidcClient, 'verifyLogoutToken'>;
  store: Pick<SessionStore, 'deleteByLogoutToken'>;
  logger?: AuthLogger;
}

/** What a request to the sink is answered with: the status and body of §2.8 on a plain `Response`. */
export async function handleBackchannelLogout(
  request: Request,
  { client, store, logger }: BackchannelLogoutOptions,
): Promise<Response> {
  const headers = { 'cache-control': 'no-store' };
  let logoutToken: string | null;
  try {
    logoutToken = await formParameter(request, 'logout_token');
  } catch {
    logoutToken = null;
  }
  if (!logoutToken) {
    logger?.warn('auth.backchannel_logout_rejected', redact({ errorCode: 'logout_token_invalid' }));
    return Response.json(
      { error: 'invalid_request', error_description: 'logout_token is required' },
      { status: 400, headers },
    );
  }
  let claims;
  try {
    claims = await client.verifyLogoutToken(logoutToken);
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    logger?.warn(
      'auth.backchannel_logout_rejected',
      redact({ errorCode: error.code, reason: error.message }),
    );
    return Response.json({ error: 'invalid_request' }, { status: 400, headers });
  }
  // Which sessions went is not logged: `sid` is an identifier of the IdP's session and the session IDs are ours.
  const deleted = await store.deleteByLogoutToken(claims);
  (logger?.info ?? logger?.warn)?.call(
    logger,
    'auth.backchannel_logout',
    redact({ deleted, bySid: claims.sid !== undefined, bySub: claims.sub !== undefined }),
  );
  return new Response(null, { status: 200, headers });
}

/** One parameter of an `application/x-www-form-urlencoded` body (§2.5), read without the framework's parser. */
async function formParameter(request: Request, name: string): Promise<string | null> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/x-www-form-urlencoded(\s*;|$)/i.test(type)) return null;
  return new URLSearchParams(await request.text()).get(name);
}
