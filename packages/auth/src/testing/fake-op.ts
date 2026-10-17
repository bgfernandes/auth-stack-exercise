/**
 * An in-process OpenID Provider for the unit tests (`@auth-stack/auth/testing`): served to `openid-client`
 * through its `customFetch` hook, so no socket and no interception library. Discovery, JWKS, and the token
 * endpoint (code exchange with PKCE, refresh with rotation) behave like Zitadel's as far as the package relies
 * on them; the browser leg of the flow is `authorize()`, which plays the user logging in and returns the callback
 * URL. Knobs force the failure paths: a wrong nonce, a tampered issuer, a refused refresh.
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
}

export interface FakeOpOptions {
  issuer?: string;
  clientId: string;
  /** A second audience, like Zitadel's project ID; `azp` names the client then. */
  projectId?: string;
  accessTokenSeconds?: number;
}

export interface IdTokenOverrides {
  nonce?: string;
  iss?: string;
  aud?: string | string[];
  /** Seconds since the epoch; forces an expired token. */
  exp?: number;
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
  /** Every refresh token currently valid; rotation removes the one used. */
  readonly refreshTokens: Set<string>;
  /** How many token requests the OP has served, by grant. */
  readonly grants: { authorization_code: number; refresh_token: number };
  /** Signs arbitrary claims with the OP's key (tickets 15 and 18 build bearer and logout tokens with it); `typ` goes in the header. */
  sign(claims: Record<string, unknown>, header?: { typ?: string }): Promise<string>;
}

interface PendingCode {
  user: FakeUser;
  nonce: string | undefined;
  codeChallenge: string | undefined;
  redirectUri: string;
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
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test-key', use: 'sig', alg: 'ES256' };

  const metadata: ServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    end_session_endpoint: `${issuer}/end_session`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['ES256'],
    token_endpoint_auth_methods_supported: ['none'],
  };

  const codes = new Map<string, PendingCode>();
  const refreshTokens = new Map<string, FakeUser>();
  const grants = { authorization_code: 0, refresh_token: 0 };
  let tamper: IdTokenOverrides | undefined;

  const sign = (claims: Record<string, unknown>, header: { typ?: string } = {}): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid as string, ...header })
      .sign(privateKey);

  async function idToken(user: FakeUser, nonce: string | undefined): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: issuer,
      sub: user.sub,
      aud: projectId ? [clientId, projectId] : clientId,
      ...(projectId ? { azp: clientId } : {}),
      iat: now,
      exp: now + accessTokenSeconds,
      auth_time: now - 5,
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

  async function tokenResponse(user: FakeUser, nonce: string | undefined): Promise<Response> {
    const refreshToken = randomBytes(16).toString('base64url');
    refreshTokens.set(refreshToken, user);
    return json({
      access_token: `at-${randomBytes(8).toString('base64url')}`,
      token_type: 'Bearer',
      expires_in: accessTokenSeconds,
      refresh_token: refreshToken,
      id_token: await idToken(user, nonce),
      scope: 'openid profile email offline_access',
    });
  }

  async function token(request: { body?: unknown }): Promise<Response> {
    const body = request.body;
    const form = new URLSearchParams(
      typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : '',
    );
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
      return tokenResponse(pending.user, pending.nonce);
    }
    if (grantType === 'refresh_token') {
      grants.refresh_token += 1;
      const used = form.get('refresh_token') ?? '';
      const user = refreshTokens.get(used);
      if (!user)
        return json({ error: 'invalid_grant', error_description: 'unknown refresh token' }, 400);
      refreshTokens.delete(used);
      return tokenResponse(user, undefined);
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  }

  const fetch: FakeFetch = async (url, request) => {
    const { pathname } = new URL(url);
    if (!url.startsWith(issuer)) return new Response('not the OP', { status: 502 });
    if (pathname === '/.well-known/openid-configuration') return json(metadata);
    if (pathname === '/jwks') return json({ keys: [jwk] });
    if (pathname === '/token' && request.method === 'POST') return token(request);
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
      codes.set(code, {
        user,
        nonce: params.get('nonce') ?? undefined,
        codeChallenge: params.get('code_challenge') ?? undefined,
        redirectUri,
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
    sign,
  };
}
