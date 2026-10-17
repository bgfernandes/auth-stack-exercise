/**
 * A valid access token for a session (docs/README.md §4.4 step 7): the stored one while it has more than a
 * minute left, otherwise a refresh through the refresh token, written back with `update`. Parallel server
 * components of one render all ask at once and Zitadel rotates refresh tokens, so refreshes are deduplicated per
 * session in the process, and a refused refresh re-reads the session before giving up, in case another process
 * refreshed first. A session whose refresh token is rejected is deleted; the caller sends the browser to login.
 */
import { AuthError } from './errors';
import { oauthErrorOf, type OidcClient } from './oidc';
import { redact, type AuthLogger } from './redact';

import type { Session, SessionPatch, SessionStore } from './session';

export const REFRESH_MARGIN_MS = 60_000;

export interface AccessTokenProviderOptions {
  client: OidcClient;
  store: SessionStore;
  logger?: AuthLogger;
  now?: () => number;
}

export interface AccessTokenProvider {
  /** The token, or undefined when the session cannot get one and the user must log in again. */
  getAccessToken: (session: Session) => Promise<string | undefined>;
}

export function createAccessTokenProvider(
  options: AccessTokenProviderOptions,
): AccessTokenProvider {
  const { client, store, logger } = options;
  const now = options.now ?? Date.now;
  const inFlight = new Map<string, Promise<string | undefined>>();

  const fresh = (session: Session) => session.accessTokenExpiresAt - now() > REFRESH_MARGIN_MS;

  async function refresh(session: Session): Promise<string | undefined> {
    if (!session.refreshToken) return undefined;
    try {
      const tokens = await client.refresh(session.refreshToken);
      const patch: SessionPatch = {
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      };
      if (tokens.refreshToken !== undefined) patch.refreshToken = tokens.refreshToken;
      if (tokens.idToken !== undefined) patch.idToken = tokens.idToken;
      return (await store.update(session.id, patch)) ? tokens.accessToken : undefined;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      const current = await store.get(session.id);
      if (current && fresh(current)) return current.accessToken;
      if (oauthErrorOf(error) === 'invalid_grant') {
        logger?.warn('auth.refresh_rejected', redact({ sub: session.sub }));
        await store.delete(session.id);
        return undefined;
      }
      throw error;
    }
  }

  return {
    async getAccessToken(session) {
      if (fresh(session)) return session.accessToken;
      let pending = inFlight.get(session.id);
      if (!pending) {
        pending = refresh(session).finally(() => inFlight.delete(session.id));
        inFlight.set(session.id, pending);
      }
      return pending;
    },
  };
}
