/**
 * The OIDC client of the BFFs (docs/README.md §4.4 steps 1, 3, 5, 7) over `openid-client` v6: authorization
 * code with PKCE `S256` (RFC 7636), `state` and `nonce` bound to the login attempt through the stash, ID-token
 * validation (`iss`, `aud`, `exp`, `nonce`, signature against JWKS) by the library, refresh through the refresh
 * token, and the RP-initiated logout URL. Discovery runs once per process and issuer.
 */
import * as oidc from 'openid-client';

import { AuthError } from './errors';
import { STASH_LIFETIME_SECONDS, type LoginStash } from './stash';

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
  /** The `end_session_endpoint` URL with `id_token_hint` and the registered post-logout redirect. */
  endSessionUrl(idToken: string | undefined): Promise<URL>;
}

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

function tokenSet(
  response: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers,
  now: number,
): TokenSet {
  const expiresIn = response.expiresIn();
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

export function createOidcClient(
  config: OidcClientConfig,
  options: OidcClientOptions = {},
): OidcClient {
  const now = options.now ?? Date.now;
  const scope = config.scope ?? DEFAULT_SCOPE;
  const configuration = () => configure(config, options);

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

    async endSessionUrl(idToken) {
      return oidc.buildEndSessionUrl(await configuration(), {
        ...(idToken ? { id_token_hint: idToken } : {}),
        post_logout_redirect_uri: config.postLogoutRedirectUri,
      });
    },
  };
}

/** The OAuth error code of a refused token request (`invalid_grant` for a rotated or revoked refresh token). */
export function oauthErrorOf(error: AuthError): string | undefined {
  return error.cause instanceof oidc.ResponseBodyError ? error.cause.error : undefined;
}
