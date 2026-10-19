/** The OIDC client against the in-process fake OP (`@auth-stack/auth/testing`): the happy path and every failure path. */
import { beforeEach, describe, expect, it } from '@jest/globals';

import { AuthError } from './errors';
import { createOidcClient, oauthErrorOf, resetDiscoveryCache, type OidcClient } from './oidc';
import { createFakeOp, type FakeOp } from './testing/fake-op';

const CLIENT_ID = 'dashboard-web';
const config = {
  issuer: 'https://op.test',
  clientId: CLIENT_ID,
  redirectUri: 'https://app.test/auth/callback',
  postLogoutRedirectUri: 'https://app.test/',
};
const alice = {
  sub: 'alice',
  email: 'alice@example.com',
  name: 'Alice',
  sid: 'sid-alice',
  amr: ['pwd', 'mfa'],
};

async function failure(promise: Promise<unknown>): Promise<AuthError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }
  throw new Error('expected an AuthError');
}

describe('createOidcClient', () => {
  let op: FakeOp;
  let client: OidcClient;

  beforeEach(async () => {
    op = await createFakeOp({ clientId: CLIENT_ID, projectId: 'project-1' });
    client = createOidcClient(config, { fetch: op.fetch, serverMetadata: op.metadata });
  });

  it('builds a PKCE S256 authorization request with fresh state and nonce', async () => {
    const { url, stash } = await client.beginLogin();
    const params = url.searchParams;
    expect(url.origin + url.pathname).toBe('https://op.test/authorize');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe(CLIENT_ID);
    expect(params.get('redirect_uri')).toBe(config.redirectUri);
    expect(params.get('scope')).toBe('openid profile email offline_access');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('state')).toBe(stash.state);
    expect(params.get('nonce')).toBe(stash.nonce);
    expect(stash.codeVerifier.length).toBeGreaterThanOrEqual(43);
    const again = await client.beginLogin();
    expect(again.stash.state).not.toBe(stash.state);
    expect(again.stash.nonce).not.toBe(stash.nonce);
  });

  it('completes a login: tokens, expiry, and the claims the session keeps', async () => {
    const { url, stash } = await client.beginLogin();
    const before = Date.now();
    const { tokens, claims } = await client.completeLogin(op.authorize(url, alice), stash);
    expect(tokens.accessToken).toMatch(/^at-/);
    expect(tokens.refreshToken).toBeDefined();
    expect(tokens.idToken).toBeDefined();
    expect(tokens.accessTokenExpiresAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(claims).toEqual({
      sub: 'alice',
      email: 'alice@example.com',
      name: 'Alice',
      sid: 'sid-alice',
      amr: ['pwd', 'mfa'],
      authTime: expect.any(Number) as unknown as number,
    });
    expect(op.grants.authorization_code).toBe(1);
  });

  it('sends the registered redirect URI, not the host the callback arrived on', async () => {
    const { url, stash } = await client.beginLogin();
    const callback = op.authorize(url, alice);
    const seenOnBindAddress = new URL(`http://0.0.0.0:3000/auth/callback${callback.search}`);
    await expect(client.completeLogin(seenOnBindAddress, stash)).resolves.toBeDefined();
  });

  it('refuses a callback whose state is not the stash one', async () => {
    const { url } = await client.beginLogin();
    const other = await client.beginLogin();
    const error = await failure(client.completeLogin(op.authorize(url, alice), other.stash));
    expect(error.code).toBe('state_mismatch');
    expect(op.grants.authorization_code).toBe(0);
  });

  it('refuses an ID token whose nonce is not the stash one', async () => {
    const { url, stash } = await client.beginLogin();
    op.tamperNextIdToken({ nonce: 'someone-elses' });
    const error = await failure(client.completeLogin(op.authorize(url, alice), stash));
    expect(error.code).toBe('nonce_mismatch');
  });

  it('refuses an ID token from another issuer, for another audience, or expired', async () => {
    for (const tamper of [{ iss: 'https://other.test' }, { aud: 'other-client' }, { exp: 1 }]) {
      const { url, stash } = await client.beginLogin();
      op.tamperNextIdToken(tamper);
      const error = await failure(client.completeLogin(op.authorize(url, alice), stash));
      expect(error.code).toBe('token_invalid');
    }
  });

  it('reports an error response from the authorization endpoint as denied', async () => {
    const { url, stash } = await client.beginLogin();
    const error = await failure(client.completeLogin(op.deny(url), stash));
    expect(error.code).toBe('authorization_denied');
  });

  it('reports a refused code exchange (a replayed code) as a failed exchange', async () => {
    const { url, stash } = await client.beginLogin();
    const callback = op.authorize(url, alice);
    await client.completeLogin(callback, stash);
    const error = await failure(client.completeLogin(callback, stash));
    expect(error.code).toBe('exchange_failed');
    expect(oauthErrorOf(error)).toBe('invalid_grant');
  });

  it('refreshes with rotation and reports a refused refresh', async () => {
    const { url, stash } = await client.beginLogin();
    const { tokens } = await client.completeLogin(op.authorize(url, alice), stash);
    const refreshed = await client.refresh(tokens.refreshToken as string);
    expect(refreshed.accessToken).not.toBe(tokens.accessToken);
    expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);
    expect(op.refreshTokens.has(tokens.refreshToken as string)).toBe(false);
    const error = await failure(client.refresh(tokens.refreshToken as string));
    expect(error.code).toBe('refresh_failed');
    expect(oauthErrorOf(error)).toBe('invalid_grant');
  });

  it('revokes a token with its type hint, and reports a refused or unsupported revocation', async () => {
    const { url, stash } = await client.beginLogin();
    const { tokens } = await client.completeLogin(op.authorize(url, alice), stash);
    await client.revoke(tokens.refreshToken as string, 'refresh_token');
    expect(op.revocations).toEqual([
      { token: tokens.refreshToken, tokenTypeHint: 'refresh_token' },
    ]);
    expect(op.refreshTokens.has(tokens.refreshToken as string)).toBe(false);
    // RFC 7009 §2.2: a token the server does not know is a success too.
    await expect(client.revoke('never-issued', 'access_token')).resolves.toBeUndefined();

    op.refuseRevocation(503);
    const refused = await failure(client.revoke(tokens.accessToken, 'access_token'));
    expect(refused.code).toBe('revocation_failed');
    expect(refused.message).not.toContain(tokens.accessToken);

    const { revocation_endpoint: _none, ...withoutRevocation } = op.metadata;
    const bare = createOidcClient(config, { fetch: op.fetch, serverMetadata: withoutRevocation });
    expect((await failure(bare.revoke(tokens.accessToken, 'access_token'))).code).toBe(
      'revocation_failed',
    );
  });

  it('builds the end-session URL with the ID token hint and the registered post-logout redirect', async () => {
    const url = await client.endSessionUrl('the-id-token');
    expect(url.origin + url.pathname).toBe('https://op.test/end_session');
    expect(url.searchParams.get('id_token_hint')).toBe('the-id-token');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.test/');
    expect((await client.endSessionUrl(undefined)).searchParams.has('id_token_hint')).toBe(false);
  });

  it('discovers the issuer once per process through the custom fetch', async () => {
    resetDiscoveryCache();
    let discoveries = 0;
    const counting: typeof op.fetch = (url, request) => {
      if (url.endsWith('/.well-known/openid-configuration')) discoveries += 1;
      return op.fetch(url, request);
    };
    const discovered = createOidcClient(config, { fetch: counting });
    const { url, stash } = await discovered.beginLogin();
    await discovered.completeLogin(op.authorize(url, alice), stash);
    await createOidcClient(config, { fetch: counting }).beginLogin();
    expect(discoveries).toBe(1);
  });
});
