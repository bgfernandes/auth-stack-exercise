/**
 * An in-process OpenID Provider for the unit tests (`@auth-stack/auth/testing`): served to `openid-client`
 * through its `customFetch` hook, so no socket and no interception library. Discovery, JWKS, the token
 * endpoint (code exchange with PKCE, refresh with rotation), and the revocation endpoint (RFC 7009) behave like
 * Zitadel's as far as the package relies on them; the browser leg of the flow is `authorize()`, which plays the
 * user logging in and returns the callback URL. Knobs force the failure paths: a wrong nonce, a tampered issuer,
 * a refused refresh, a revocation endpoint that is down.
 */
import { createHash, randomBytes } from 'node:crypto';

import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

import type { ServerMetadata } from 'openid-client';

/** Drops the package's per-process discovery cache between tests. */
export { resetDiscoveryCache } from '../oidc';

/**
 * The shape both `openid-client` (`customFetch`) and jose (`createRemoteJWKSet`) call a fetch replacement with;
 * the OP only reads the method and the body.
 */
export type FakeFetch = (
  url: string,
  request: { method?: string; headers?: unknown; body?: unknown; signal?: AbortSignal },
) => Promise<Response>;

export interface FakeUser {
  sub: string;
  email?: string;
  name?: string;
  sid?: string;
  amr?: string[];
  /**
   * When the user authenticated at the OP, in seconds since the epoch; five seconds before the token by default.
   * An authorization request whose `max_age` has elapsed since then re-authenticates the user (OpenID Connect
   * Core 1.0 §3.1.2.1), so the ID token's `auth_time` is the token's time, unless the OP `ignoresMaxAge`.
   */
  authTime?: number;
}

export interface FakeOpOptions {
  issuer?: string;
  clientId: string;
  /** A second audience, like Zitadel's project ID; `azp` names the client then. */
  projectId?: string;
  accessTokenSeconds?: number;
  /** An OP that does not honour `max_age`: the ID token keeps the user's `authTime` however old it is. */
  ignoresMaxAge?: boolean;
}

export interface IdTokenOverrides {
  nonce?: string;
  iss?: string;
  aud?: string | string[];
  /** Seconds since the epoch; forces an expired token. */
  exp?: number;
  /** Seconds since the epoch; `undefined` drops the claim. */
  auth_time?: number | undefined;
}

export interface FakeOp {
  issuer: string;
  metadata: ServerMetadata;
  fetch: FakeFetch;
  /** The user's login at the OP: records the request, returns the callback URL (`redirect_uri?code&state`). */
  authorize(authorizationUrl: URL, user: FakeUser): URL;
  /** The OP answers the callback with an error instead of a code. */
  deny(authorizationUrl: URL, error?: string): URL;
  /** Applies to the next ID token the OP issues. */
  tamperNextIdToken(overrides: IdTokenOverrides): void;
  /** Every refresh token currently valid; rotation removes the one used, as does its revocation. */
  readonly refreshTokens: Set<string>;
  /** How many token requests the OP has served, by grant. */
  readonly grants: { authorization_code: number; refresh_token: number };
  /** Every revocation request served (RFC 7009 §2.1), in order, with the `token_type_hint` it carried. */
  readonly revocations: { token: string; tokenTypeHint: string | null }[];
  /** Every revocation request from now on is answered with `status` (RFC 7009 §2.2.1: a server error). */
  refuseRevocation(status?: number): void;
  /**
   * Signs arbitrary claims with the OP's key (tickets 15 and 18 build bearer and logout tokens with it); `typ`
   * goes in the header. The key is RS256, as Zitadel's; `alg: 'ES256'` signs with the OP's second key, published
   * in the same JWKS, for the tests that prove the verifiers pin the algorithm.
   */
  sign(
    claims: Record<string, unknown>,
    header?: { typ?: string; alg?: 'RS256' | 'ES256' },
  ): Promise<string>;
}

interface PendingCode {
  user: FakeUser;
  nonce: string | undefined;
  codeChallenge: string | undefined;
  redirectUri: string;
  /** The request's `max_age`, in seconds, when it carried one. */
  maxAge: number | undefined;
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function createFakeOp(options: FakeOpOptions): Promise<FakeOp> {
  const issuer = options.issuer ?? 'https://op.test';
  const { clientId, projectId } = options;
  const accessTokenSeconds = options.accessTokenSeconds ?? 600;
  const [rsa, ec] = await Promise.all([generateKeyPair('RS256'), generateKeyPair('ES256')]);
  const jwk: JWK = {
    ...(await exportJWK(rsa.publicKey)),
    kid: 'test-key',
    use: 'sig',
    alg: 'RS256',
  };
  const ecJwk: JWK = {
    ...(await exportJWK(ec.publicKey)),
    kid: 'test-key-ec',
    use: 'sig',
    alg: 'ES256',
  };

  const metadata: ServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    revocation_endpoint: `${issuer}/revoke`,
    end_session_endpoint: `${issuer}/end_session`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['none'],
  };

  const codes = new Map<string, PendingCode>();
  const refreshTokens = new Map<string, FakeUser>();
  const grants = { authorization_code: 0, refresh_token: 0 };
  const revocations: { token: string; tokenTypeHint: string | null }[] = [];
  let revocationStatus: number | undefined;
  let tamper: IdTokenOverrides | undefined;

  const sign = (
    claims: Record<string, unknown>,
    header: { typ?: string; alg?: 'RS256' | 'ES256' } = {},
  ): Promise<string> => {
    const { alg = 'RS256', ...rest } = header;
    const key = alg === 'ES256' ? ec : rsa;
    const kid = (alg === 'ES256' ? ecJwk : jwk).kid as string;
    return new SignJWT(claims).setProtectedHeader({ alg, kid, ...rest }).sign(key.privateKey);
  };

  async function idToken(
    user: FakeUser,
    nonce: string | undefined,
    maxAge: number | undefined,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    let authTime = user.authTime ?? now - 5;
    if (maxAge !== undefined && now - authTime > maxAge && !options.ignoresMaxAge) authTime = now;
    const claims: Record<string, unknown> = {
      iss: issuer,
      sub: user.sub,
      aud: projectId ? [clientId, projectId] : clientId,
      ...(projectId ? { azp: clientId } : {}),
      iat: now,
      exp: now + accessTokenSeconds,
      auth_time: authTime,
      amr: user.amr ?? ['pwd'],
      ...(nonce ? { nonce } : {}),
      ...(user.sid ? { sid: user.sid } : {}),
      ...(user.email ? { email: user.email, email_verified: true } : {}),
      ...(user.name ? { name: user.name } : {}),
    };
    if (tamper) {
      Object.assign(claims, tamper);
      tamper = undefined;
    }
    return sign(claims);
  }

  async function tokenResponse(
    user: FakeUser,
    nonce: string | undefined,
    maxAge: number | undefined,
  ): Promise<Response> {
    const refreshToken = randomBytes(16).toString('base64url');
    refreshTokens.set(refreshToken, user);
    return json({
      access_token: `at-${randomBytes(8).toString('base64url')}`,
      token_type: 'Bearer',
      expires_in: accessTokenSeconds,
      refresh_token: refreshToken,
      id_token: await idToken(user, nonce, maxAge),
      scope: 'openid profile email offline_access',
    });
  }

  function formOf(request: { body?: unknown }): URLSearchParams {
    const body = request.body;
    return new URLSearchParams(
      typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : '',
    );
  }

  async function token(request: { body?: unknown }): Promise<Response> {
    const form = formOf(request);
    if (form.get('client_id') !== clientId) return json({ error: 'invalid_client' }, 401);
    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') {
      grants.authorization_code += 1;
      const pending = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (!pending || pending.redirectUri !== form.get('redirect_uri')) {
        return json({ error: 'invalid_grant', error_description: 'unknown code' }, 400);
      }
      const verifier = form.get('code_verifier');
      if (pending.codeChallenge && (!verifier || s256(verifier) !== pending.codeChallenge)) {
        return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
      }
      return tokenResponse(pending.user, pending.nonce, pending.maxAge);
    }
    if (grantType === 'refresh_token') {
      grants.refresh_token += 1;
      const used = form.get('refresh_token') ?? '';
      const user = refreshTokens.get(used);
      if (!user)
        return json({ error: 'invalid_grant', error_description: 'unknown refresh token' }, 400);
      refreshTokens.delete(used);
      return tokenResponse(user, undefined, undefined);
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  }

  /** RFC 7009 §2: the client's own authentication, then `200` whether or not the token was known (§2.2). */
  function revoke(request: { body?: unknown }): Response {
    const form = formOf(request);
    if (form.get('client_id') !== clientId) return json({ error: 'invalid_client' }, 401);
    const token = form.get('token');
    if (!token) return json({ error: 'invalid_request' }, 400);
    if (revocationStatus !== undefined) return json({ error: 'server_error' }, revocationStatus);
    revocations.push({ token, tokenTypeHint: form.get('token_type_hint') });
    refreshTokens.delete(token);
    return new Response(null, { status: 200 });
  }

  const fetch: FakeFetch = async (url, request) => {
    const { pathname } = new URL(url);
    if (!url.startsWith(issuer)) return new Response('not the OP', { status: 502 });
    if (pathname === '/.well-known/openid-configuration') return json(metadata);
    if (pathname === '/jwks') return json({ keys: [jwk, ecJwk] });
    if (pathname === '/token' && request.method === 'POST') return token(request);
    if (pathname === '/revoke' && request.method === 'POST') return revoke(request);
    return new Response('not found', { status: 404 });
  };

  return {
    issuer,
    metadata,
    fetch,
    authorize(authorizationUrl, user) {
      const params = authorizationUrl.searchParams;
      const redirectUri = params.get('redirect_uri');
      if (!redirectUri) throw new Error('authorization request without redirect_uri');
      const code = randomBytes(12).toString('base64url');
      const maxAge = params.get('max_age');
      codes.set(code, {
        user,
        nonce: params.get('nonce') ?? undefined,
        codeChallenge: params.get('code_challenge') ?? undefined,
        redirectUri,
        maxAge: maxAge === null ? undefined : Number(maxAge),
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      const state = params.get('state');
      if (state) callback.searchParams.set('state', state);
      return callback;
    },
    deny(authorizationUrl, error = 'access_denied') {
      const params = authorizationUrl.searchParams;
      const callback = new URL(params.get('redirect_uri') ?? '');
      callback.searchParams.set('error', error);
      const state = params.get('state');
      if (state) callback.searchParams.set('state', state);
      return callback;
    },
    tamperNextIdToken(overrides) {
      tamper = overrides;
    },
    get refreshTokens() {
      return new Set(refreshTokens.keys());
    },
    grants,
    revocations,
    refuseRevocation(status = 503) {
      revocationStatus = status;
    },
    sign,
  };
}
