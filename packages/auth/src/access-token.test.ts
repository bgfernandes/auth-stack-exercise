import { beforeEach, describe, expect, it } from '@jest/globals';

import { createAccessTokenProvider, type AccessTokenProvider } from './access-token';
import { createOidcClient, type OidcClient } from './oidc';
import { sessionFromLogin, type Session, type SessionStore } from './session';
import { createMemorySessionStore } from './stores/memory';
import { createFakeOp, type FakeOp } from './testing/fake-op';

const config = {
  issuer: 'https://op.test',
  clientId: 'c',
  redirectUri: 'https://app.test/auth/callback',
  postLogoutRedirectUri: 'https://app.test/',
};

describe('getAccessToken', () => {
  const clock = { now: 1_700_000_000_000 };
  const now = () => clock.now;
  let op: FakeOp;
  let client: OidcClient;
  let store: SessionStore;
  let provider: AccessTokenProvider;
  let session: Session;
  const warnings: string[] = [];

  beforeEach(async () => {
    clock.now = 1_700_000_000_000;
    op = await createFakeOp({ clientId: 'c' });
    client = createOidcClient(
      { ...config, clientKey: op.clientKey },
      { fetch: op.fetch, serverMetadata: op.metadata, now },
    );
    store = createMemorySessionStore({ now });
    provider = createAccessTokenProvider({
      client,
      store,
      now,
      logger: { warn: (e) => warnings.push(e) },
    });
    const { url, stash } = await client.beginLogin();
    session = await store.create(
      sessionFromLogin(await client.completeLogin(op.authorize(url, { sub: 'alice' }), stash)),
    );
  });

  it('returns the stored token while it has more than a minute left', async () => {
    clock.now += 600_000 - 61_000;
    await expect(provider.getAccessToken(session)).resolves.toBe(session.accessToken);
    expect(op.grants.refresh_token).toBe(0);
  });

  it('refreshes a token with less than a minute left and stores the rotated pair', async () => {
    clock.now += 600_000 - 59_000;
    const token = await provider.getAccessToken(session);
    expect(token).not.toBe(session.accessToken);
    const stored = (await store.get(session.id)) as Session;
    expect(stored.accessToken).toBe(token);
    expect(stored.refreshToken).not.toBe(session.refreshToken);
    expect(stored.accessTokenExpiresAt).toBe(clock.now + 600_000);
    expect(op.grants.refresh_token).toBe(1);
  });

  it('refreshes once for concurrent callers of the same session', async () => {
    clock.now += 600_000;
    const tokens = await Promise.all([1, 2, 3].map(() => provider.getAccessToken(session)));
    expect(new Set(tokens).size).toBe(1);
    expect(op.grants.refresh_token).toBe(1);
  });

  it('uses the tokens another process stored when its own refresh is refused', async () => {
    clock.now += 600_000;
    const other = await client.refresh(session.refreshToken as string); // rotates: ours is now dead
    await store.update(session.id, {
      accessToken: other.accessToken,
      accessTokenExpiresAt: other.accessTokenExpiresAt,
      refreshToken: other.refreshToken as string,
    });
    await expect(provider.getAccessToken(session)).resolves.toBe(other.accessToken);
    await expect(store.get(session.id)).resolves.toBeDefined();
  });

  it('deletes the session when the refresh token is rejected and nobody refreshed it', async () => {
    clock.now += 600_000;
    await client.refresh(session.refreshToken as string);
    await expect(provider.getAccessToken(session)).resolves.toBeUndefined();
    await expect(store.get(session.id)).resolves.toBeUndefined();
    expect(warnings).toContain('auth.refresh_rejected');
  });

  it('returns nothing for a session without a refresh token, and nothing after a logout', async () => {
    clock.now += 600_000;
    const { refreshToken: _dropped, ...rest } = session;
    await expect(provider.getAccessToken(rest)).resolves.toBeUndefined();
    await store.delete(session.id);
    await expect(provider.getAccessToken(session)).resolves.toBeUndefined();
    await expect(store.get(session.id)).resolves.toBeUndefined();
  });
});
