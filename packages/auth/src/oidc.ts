/**
 * The OIDC client of the BFFs (docs/README.md §4.4 steps 1, 3, 5, 6, 7) over `openid-client` v6: authorization
 * code with PKCE `S256` (RFC 7636), `state` and `nonce` bound to the login attempt through the stash, ID-token
 * validation (`iss`, `aud`, `exp`, `nonce`, signature against JWKS) by the library, refresh through the refresh
 * token, token revocation (RFC 7009) at logout, the RP-initiated logout URL, and the validation of a back-channel
 * logout token against the same JWKS. Discovery runs once per process and issuer.
 */
import { createRemoteJWKSet, customFetch, errors as joseErrors, jwtVerify } from 'jose';
import * as oidc from 'openid-client';

import { AuthError } from './errors';
import { STASH_LIFETIME_SECONDS, type LoginStash } from './stash';

import type { LogoutTokenClaims } from './session';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';

export type OidcFetch = NonNullable<oidc.Configuration[typeof oidc.customFetch]>;

export interface OidcClientConfig {
  /** The issuer URL, as discovery and the tokens' `iss` state it. */
  issuer: string;
  /** A public client (PKCE, no secret), as bootstrap registers the web applications. */
  clientId: string;
  /** The registered redirect URI; always what the token request carries, never the host the server saw. */
  redirectUri: string;
  /** The registered post-logout redirect URI. */
  postLogoutRedirectUri: string;
  /** Defaults to `openid profile email offline_access`. */
  scope?: string;
}

export interface OidcClientOptions {
  /** Replaces the library's `fetch` (the tests' fake OP; a `Host` override in a deployment that needs one). */
  fetch?: OidcFetch;
  /** Skips discovery, for tests that build the server from metadata. */
  serverMetadata?: oidc.ServerMetadata;
  now?: () => number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Epoch milliseconds. */
  accessTokenExpiresAt: number;
}

/** What the session keeps from the ID token: identity, the IdP session, and the authentication evidence (§9.1). */
export interface IdentityClaims {
  sub: string;
  email?: string;
  name?: string;
  /** The IdP session ID; back-channel logout tokens name it. */
  sid?: string;
  /** Epoch milliseconds of the authentication the ID token attests. */
  authTime?: number;
  /** Authentication methods references (`pwd`, `mfa`, `otp`, ...); empty when the IdP sent none. */
  amr: string[];
}

/** The `token_type_hint` of RFC 7009 §2.1. */
export type TokenTypeHint = 'access_token' | 'refresh_token';

export interface LoginResult {
  tokens: TokenSet;
  claims: IdentityClaims;
}

export interface OidcClient {
  /** The authorization URL to redirect to, and the stash the callback needs, to seal into the login cookie. */
  beginLogin(): Promise<{ url: URL; stash: LoginStash }>;
  /** Verifies the callback against the stash, exchanges the code, validates the tokens. Throws `AuthError`. */
  completeLogin(callbackUrl: URL, stash: LoginStash): Promise<LoginResult>;
  /** A new token set through the refresh token. Throws `AuthError('refresh_failed')`. */
  refresh(refreshToken: string): Promise<TokenSet>;
  /**
   * Revokes a token at the issuer's `revocation_endpoint` (RFC 7009 §2.1), with the client's own authentication
   * (`client_id` alone for the public clients bootstrap registers). Throws `AuthError('revocation_failed')`,
   * also when the issuer publishes no revocation endpoint; the server's answer on an unknown token is a success
   * (§2.2), so a token already gone does not fail.
   */
  revoke(token: string, tokenTypeHint: TokenTypeHint): Promise<void>;
  /** The `end_session_endpoint` URL with `id_token_hint` and the registered post-logout redirect. */
  endSessionUrl(idToken: string | undefined): Promise<URL>;
  /**
   * Validates a logout token (OpenID Connect Back-Channel Logout 1.0 §2.6) and returns what it names: `sid`,
   * `sub`, or both. Throws `AuthError('logout_token_invalid')`.
   */
  verifyLogoutToken(logoutToken: string): Promise<LogoutTokenClaims>;
}

/** The member a logout token's `events` claim must carry (Back-Channel Logout 1.0 §2.4). */
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

export const DEFAULT_SCOPE = 'openid profile email offline_access';

const configurations = new Map<string, Promise<oidc.Configuration>>();

/** Drops the per-process discovery cache; tests only (re-exported by `@auth-stack/auth/testing`). */
export function resetDiscoveryCache(): void {
  configurations.clear();
}

async function configure(
  config: OidcClientConfig,
  options: OidcClientOptions,
): Promise<oidc.Configuration> {
  const insecure = config.issuer.startsWith('http://');
  if (options.serverMetadata) {
    const configuration = new oidc.Configuration(
      options.serverMetadata,
      config.clientId,
      undefined,
      oidc.None(),
    );
    if (insecure) oidc.allowInsecureRequests(configuration);
    if (options.fetch) configuration[oidc.customFetch] = options.fetch;
    return configuration;
  }
  const key = `${config.issuer} ${config.clientId}`;
  let pending = configurations.get(key);
  if (!pending) {
    pending = oidc
      .discovery(new URL(config.issuer), config.clientId, undefined, oidc.None(), {
        // The issuer is plain http inside compose; the library refuses that unless told otherwise.
        execute: insecure ? [oidc.allowInsecureRequests] : [],
        ...(options.fetch ? { [oidc.customFetch]: options.fetch } : {}),
      })
      .then((configuration) => {
        if (options.fetch) configuration[oidc.customFetch] = options.fetch;
        return configuration;
      });
    configurations.set(key, pending);
    // A failed discovery is retried on the next call rather than cached.
    pending.catch(() => configurations.delete(key));
  }
  return pending;
}

/**
 * The token pair with its expiry on the caller's clock: `expires_in` (RFC 6749 §5.1, seconds, validated as a
 * number by openid-client) from `now`. Not the helper `expiresIn()`, which counts down on the real clock and
 * floors to whole seconds, so it loses a second as soon as a millisecond passed since the response and ignores
 * an injected clock.
 */
function tokenSet(response: oidc.TokenEndpointResponse, now: number): TokenSet {
  const expiresIn = response.expires_in;
  if (expiresIn === undefined) {
    throw new AuthError('token_invalid', 'token response carries no expires_in');
  }
  const set: TokenSet = {
    accessToken: response.access_token,
    accessTokenExpiresAt: now + expiresIn * 1000,
  };
  if (response.refresh_token) set.refreshToken = response.refresh_token;
  if (response.id_token) set.idToken = response.id_token;
  return set;
}

function identityClaims(claims: oidc.IDToken): IdentityClaims {
  const identity: IdentityClaims = {
    sub: claims.sub,
    amr: Array.isArray(claims.amr)
      ? claims.amr.filter((m): m is string => typeof m === 'string')
      : [],
  };
  if (typeof claims.email === 'string') identity.email = claims.email;
  if (typeof claims.name === 'string') identity.name = claims.name;
  if (typeof claims.sid === 'string') identity.sid = claims.sid;
  if (typeof claims.auth_time === 'number') identity.authTime = claims.auth_time * 1000;
  return identity;
}

/** Maps what `openid-client` throws on the code exchange to the package's codes; the cause is kept for the log. */
function loginError(error: unknown): AuthError {
  if (error instanceof oidc.AuthorizationResponseError) {
    return new AuthError('authorization_denied', `authorization response error: ${error.error}`, {
      cause: error,
    });
  }
  if (error instanceof oidc.ResponseBodyError) {
    return new AuthError('exchange_failed', `token endpoint error: ${error.error}`, {
      cause: error,
    });
  }
  if (error instanceof oidc.ClientError && error.code === 'OAUTH_JWT_CLAIM_COMPARISON_FAILED') {
    // The library's own error names the claim (its cause carries `{ claim, expected, claims }`).
    const inner = error.cause as { cause?: { claim?: unknown } } | undefined;
    if (inner?.cause?.claim === 'nonce') {
      return new AuthError('nonce_mismatch', 'ID token nonce mismatch', { cause: error });
    }
  }
  return new AuthError('token_invalid', 'token response failed validation', { cause: error });
}

/**
 * The checks of Back-Channel Logout 1.0 §2.6 beyond what `jwtVerify` did (signature, `iss`, `aud`, `exp`,
 * `iat` present): the `events` member, no `nonce`, and `sid` or `sub`. The token is a JWT of the same issuer
 * and audience as an ID token, so the `events` member and the absent `nonce` are what tell the two apart; an
 * ID token replayed here is refused on both.
 */
function logoutTokenClaims(payload: JWTPayload): LogoutTokenClaims {
  const events = payload.events;
  if (typeof events !== 'object' || events === null || Array.isArray(events)) {
    throw new AuthError('logout_token_invalid', 'logout token carries no events claim');
  }
  const event = (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT];
  if (typeof event !== 'object' || event === null) {
    throw new AuthError('logout_token_invalid', 'logout token carries no backchannel-logout event');
  }
  if ('nonce' in payload) {
    throw new AuthError('logout_token_invalid', 'logout token carries a nonce');
  }
  const claims: LogoutTokenClaims = {};
  if (typeof payload.sid === 'string' && payload.sid !== '') claims.sid = payload.sid;
  if (typeof payload.sub === 'string' && payload.sub !== '') claims.sub = payload.sub;
  if (claims.sid === undefined && claims.sub === undefined) {
    throw new AuthError('logout_token_invalid', 'logout token names neither sid nor sub');
  }
  return claims;
}

/** Seconds of leeway on `exp` and `iat`, as the bearer verifier gives access tokens. */
const LOGOUT_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

export function createOidcClient(
  config: OidcClientConfig,
  options: OidcClientOptions = {},
): OidcClient {
  const now = options.now ?? Date.now;
  const scope = config.scope ?? DEFAULT_SCOPE;
  const configuration = () => configure(config, options);

  // The issuer's JWKS, from discovery, fetched and cached by jose; through the same `fetch` as everything else.
  let jwks: JWTVerifyGetKey | undefined;
  const signingKey = async (): Promise<JWTVerifyGetKey> => {
    if (!jwks) {
      const { jwks_uri: jwksUri } = (await configuration()).serverMetadata();
      if (!jwksUri) throw new AuthError('token_invalid', 'the issuer publishes no jwks_uri');
      const fetch = options.fetch;
      jwks = createRemoteJWKSet(new URL(jwksUri), {
        ...(fetch
          ? { [customFetch]: (url, init) => fetch(url, { ...init, body: undefined, headers: {} }) }
          : {}),
      });
    }
    return jwks;
  };

  return {
    async beginLogin() {
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const stash: LoginStash = {
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        codeVerifier,
        expiresAt: now() + STASH_LIFETIME_SECONDS * 1000,
      };
      const url = oidc.buildAuthorizationUrl(await configuration(), {
        redirect_uri: config.redirectUri,
        scope,
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state: stash.state,
        nonce: stash.nonce,
      });
      return { url, stash };
    },

    async completeLogin(callbackUrl, stash) {
      // The registered URI plus the callback's query: the standalone server reports the bind address as the
      // request host, so the host it saw never reaches the token request (ticket 3's finding).
      const current = new URL(config.redirectUri);
      current.search = callbackUrl.search;
      if (current.searchParams.get('state') !== stash.state) {
        throw new AuthError('state_mismatch', 'callback state is not the one of this login');
      }
      let response;
      try {
        response = await oidc.authorizationCodeGrant(await configuration(), current, {
          pkceCodeVerifier: stash.codeVerifier,
          expectedState: stash.state,
          expectedNonce: stash.nonce,
          idTokenExpected: true,
        });
      } catch (error) {
        throw loginError(error);
      }
      const claims = response.claims();
      if (!claims) throw new AuthError('token_invalid', 'token response carries no ID token');
      return { tokens: tokenSet(response, now()), claims: identityClaims(claims) };
    },

    async refresh(refreshToken) {
      try {
        const response = await oidc.refreshTokenGrant(await configuration(), refreshToken);
        return tokenSet(response, now());
      } catch (error) {
        if (error instanceof AuthError) throw error;
        const detail = error instanceof oidc.ResponseBodyError ? error.error : 'validation';
        throw new AuthError('refresh_failed', `refresh failed: ${detail}`, { cause: error });
      }
    },

    async revoke(token, tokenTypeHint) {
      const configured = await configuration();
      if (!configured.serverMetadata().revocation_endpoint) {
        throw new AuthError('revocation_failed', 'the issuer publishes no revocation_endpoint');
      }
      try {
        await oidc.tokenRevocation(configured, token, { token_type_hint: tokenTypeHint });
      } catch (error) {
        const detail = error instanceof oidc.ResponseBodyError ? error.error : 'request';
        throw new AuthError('revocation_failed', `${tokenTypeHint} revocation failed: ${detail}`, {
          cause: error,
        });
      }
    },

    async endSessionUrl(idToken) {
      return oidc.buildEndSessionUrl(await configuration(), {
        ...(idToken ? { id_token_hint: idToken } : {}),
        post_logout_redirect_uri: config.postLogoutRedirectUri,
      });
    },

    async verifyLogoutToken(logoutToken) {
      let payload: JWTPayload;
      try {
        // `aud` must contain this client's ID (an ID token's audience; Zitadel adds the project ID, which jose
        // tolerates: a string audience is matched against every member of an array). `iat` is required of a
        // logout token where an ID token's validation only checks it when present.
        ({ payload } = await jwtVerify(logoutToken, await signingKey(), {
          issuer: config.issuer,
          audience: config.clientId,
          requiredClaims: ['iat', 'exp'],
          clockTolerance: LOGOUT_TOKEN_CLOCK_TOLERANCE_SECONDS,
          currentDate: new Date(now()),
        }));
      } catch (error) {
        // As in the bearer verifier: a verdict on the token is the token's fault; a JWKS that cannot be fetched
        // is ours, and propagates so the IdP sees a server error and may retry rather than a refusal.
        if (
          error instanceof joseErrors.JOSEError &&
          error.code !== 'ERR_JOSE_GENERIC' &&
          error.code !== 'ERR_JWKS_TIMEOUT'
        ) {
          throw new AuthError('logout_token_invalid', 'logout token failed verification', {
            cause: error,
          });
        }
        throw error;
      }
      return logoutTokenClaims(payload);
    },
  };
}

/** The OAuth error code of a refused token request (`invalid_grant` for a rotated or revoked refresh token). */
export function oauthErrorOf(error: AuthError): string | undefined {
  return error.cause instanceof oidc.ResponseBodyError ? error.cause.error : undefined;
}
