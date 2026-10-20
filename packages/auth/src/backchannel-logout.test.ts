/**
 * The back-channel logout sink against logout tokens the fake OP signs: the validation of §2.6 of OpenID Connect
 * Back-Channel Logout 1.0 claim by claim, and the handler's answers over the memory store.
 */
import { beforeEach, describe, expect, it } from '@jest/globals';

import { handleBackchannelLogout, MAX_BODY_BYTES } from './backchannel-logout';
import { AuthError } from './errors';
import { BACKCHANNEL_LOGOUT_EVENT, createOidcClient, type OidcClient } from './oidc';
import { type NewSession, type SessionStore } from './session';
import { createMemorySessionStore } from './stores/memory';
import { createFakeOp, type FakeOp } from './testing/fake-op';

const CLIENT_ID = 'dashboard-web';
const config = {
  issuer: 'https://op.test',
  clientId: CLIENT_ID,
  redirectUri: 'https://app.test/auth/callback',
  postLogoutRedirectUri: 'https://app.test/',
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

const now = () => Math.floor(Date.now() / 1000);

/** A logout token as Zitadel would issue it, with `overrides` applied last (`undefined` removes a claim). */
function logoutClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const claims: Record<string, unknown> = {
    iss: 'https://op.test',
    aud: [CLIENT_ID, 'project-1'],
    iat: now(),
    exp: now() + 120,
    jti: 'jti-1',
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    sid: 'sid-alice',
    sub: 'alice',
    ...overrides,
  };
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete claims[key];
  return claims;
}

describe('verifyLogoutToken', () => {
  let op: FakeOp;
  let client: OidcClient;

  beforeEach(async () => {
    op = await createFakeOp({ clientId: CLIENT_ID, projectId: 'project-1' });
    client = createOidcClient(
      { ...config, clientKey: op.clientKey },
      { fetch: op.fetch, serverMetadata: op.metadata },
    );
  });

  it('returns the sid and sub a valid token names, whichever are present', async () => {
    await expect(
      client.verifyLogoutToken(await op.sign(logoutClaims(), { typ: 'logout+jwt' })),
    ).resolves.toEqual({ sid: 'sid-alice', sub: 'alice' });
    await expect(
      client.verifyLogoutToken(await op.sign(logoutClaims({ sub: undefined }))),
    ).resolves.toEqual({ sid: 'sid-alice' });
    await expect(
      client.verifyLogoutToken(await op.sign(logoutClaims({ sid: undefined, aud: CLIENT_ID }))),
    ).resolves.toEqual({ sub: 'alice' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['another issuer', { iss: 'https://other.test' }],
    ['another audience', { aud: ['tenancy-web', 'project-1'] }],
    ['expired', { exp: now() - 120 }],
    ['no iat', { iat: undefined }],
    ['no exp', { exp: undefined }],
    ['no events', { events: undefined }],
    ['events without the backchannel-logout member', { events: { 'urn:other': {} } }],
    ['the event member not an object', { events: { [BACKCHANNEL_LOGOUT_EVENT]: 'yes' } }],
    ['a nonce', { nonce: 'n-1' }],
    ['neither sid nor sub', { sid: undefined, sub: undefined }],
    ['an empty sid and no sub', { sid: '', sub: undefined }],
  ])('refuses a token with %s', async (_name, overrides) => {
    const error = await failure(client.verifyLogoutToken(await op.sign(logoutClaims(overrides))));
    expect(error.code).toBe('logout_token_invalid');
  });

  it('refuses a token signed by another key or with another algorithm, and what is not a JWT', async () => {
    const other = await createFakeOp({ clientId: CLIENT_ID });
    const foreign = await other.sign(logoutClaims());
    expect((await failure(client.verifyLogoutToken(foreign))).code).toBe('logout_token_invalid');
    const es256 = await op.sign(logoutClaims(), { alg: 'ES256' });
    const refused = await failure(client.verifyLogoutToken(es256));
    expect(refused.code).toBe('logout_token_invalid');
    expect((refused.cause as { code?: string }).code).toBe('ERR_JOSE_ALG_NOT_ALLOWED');
    expect((await failure(client.verifyLogoutToken('not.a.jwt'))).code).toBe(
      'logout_token_invalid',
    );
    expect((await failure(client.verifyLogoutToken(''))).code).toBe('logout_token_invalid');
  });

  it('refuses an ID token of the same issuer and audience', async () => {
    // What `authorize` + the token endpoint would mint: a nonce and no events.
    const idToken = await op.sign(
      logoutClaims({ events: undefined, nonce: 'n-1', auth_time: now(), amr: ['pwd'] }),
    );
    expect((await failure(client.verifyLogoutToken(idToken))).code).toBe('logout_token_invalid');
  });
});

describe('handleBackchannelLogout', () => {
  let op: FakeOp;
  let client: OidcClient;
  let store: SessionStore;
  const events: string[] = [];
  const records: Record<string, unknown>[] = [];
  const logger = {
    warn: (event: string, fields?: Record<string, unknown>) => {
      events.push(`warn:${event}`);
      records.push(fields ?? {});
    },
    info: (event: string, fields?: Record<string, unknown>) => {
      events.push(`info:${event}`);
      records.push(fields ?? {});
    },
  };

  const session = (sub: string, sid: string): NewSession => ({
    sub,
    sid,
    accessToken: `at-${sub}`,
    accessTokenExpiresAt: Date.now() + 600_000,
    amr: ['pwd'],
  });

  const post = (
    body: URLSearchParams | string | null,
    contentType = 'application/x-www-form-urlencoded',
  ) =>
    handleBackchannelLogout(
      new Request('https://app.test/auth/backchannel-logout', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
      }),
      { client, store, logger },
    );

  beforeEach(async () => {
    events.length = 0;
    records.length = 0;
    op = await createFakeOp({ clientId: CLIENT_ID, projectId: 'project-1' });
    client = createOidcClient(
      { ...config, clientKey: op.clientKey },
      { fetch: op.fetch, serverMetadata: op.metadata },
    );
    store = createMemorySessionStore();
  });

  it('removes the sessions the token names and answers 200 with no body, no cookie, no redirect', async () => {
    const a1 = await store.create(session('alice', 'sid-a1'));
    const a2 = await store.create(session('alice', 'sid-a1'));
    const a3 = await store.create(session('alice', 'sid-a2'));
    const b1 = await store.create(session('bob', 'sid-b1'));
    const token = await op.sign(logoutClaims({ sid: 'sid-a1', sub: 'alice' }));

    const response = await post(new URLSearchParams({ logout_token: token }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
    await expect(store.get(a1.id)).resolves.toBeUndefined();
    await expect(store.get(a2.id)).resolves.toBeUndefined();
    await expect(store.get(a3.id)).resolves.toBeDefined();
    await expect(store.get(b1.id)).resolves.toBeDefined();
    expect(events).toEqual(['info:auth.backchannel_logout']);
    expect(records[0]).toEqual({ deleted: 2, bySid: true, bySub: true });
  });

  it('answers 200 when nothing matched: the IdP learns nothing from the count', async () => {
    const token = await op.sign(logoutClaims({ sid: 'sid-unknown', sub: undefined }));
    const response = await post(new URLSearchParams({ logout_token: token }));
    expect(response.status).toBe(200);
    expect(records[0]).toEqual({ deleted: 0, bySid: true, bySub: false });
  });

  it('answers 400 with an OAuth error body to a request without a valid token, and keeps every session', async () => {
    const alice = await store.create(session('alice', 'sid-alice'));
    const stale = await op.sign(logoutClaims({ exp: now() - 120 }));
    const responses = [
      await post(new URLSearchParams({ logout_token: stale })),
      await post(new URLSearchParams({ logout_token: 'garbage' })),
      await post(new URLSearchParams({ other: 'x' })),
      await post(null),
      await post(JSON.stringify({ logout_token: stale }), 'application/json'),
    ];
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    }
    await expect(store.get(alice.id)).resolves.toBeDefined();
    expect(events).toEqual(Array<string>(5).fill('warn:auth.backchannel_logout_rejected'));
    expect(records.every((r) => r.errorCode === 'logout_token_invalid')).toBe(true);
    expect(JSON.stringify(records)).not.toContain(stale);
  });

  it('refuses a body above 8 KiB with 400 before reading it, by Content-Length or while streaming', async () => {
    const alice = await store.create(session('alice', 'sid-alice'));
    const token = await op.sign(logoutClaims());
    const oversized = `logout_token=${token}&pad=${'x'.repeat(MAX_BODY_BYTES)}`;
    let pulls = 0;
    const streamed = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 64) controller.close();
        else controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
      },
    });
    const responses = [
      await handleBackchannelLogout(
        new Request('https://app.test/auth/backchannel-logout', {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': String(MAX_BODY_BYTES + 1),
          },
          body: 'logout_token=short',
        }),
        { client, store, logger },
      ),
      await post(oversized),
      await handleBackchannelLogout(
        new Request('https://app.test/auth/backchannel-logout', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: streamed,
          duplex: 'half',
        }),
        { client, store, logger },
      ),
    ];
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    }
    expect(pulls).toBeLessThan(64);
    await expect(store.get(alice.id)).resolves.toBeDefined();
    expect(events).toEqual(Array<string>(3).fill('warn:auth.backchannel_logout_rejected'));
    expect(records.every((r) => r.errorCode === 'logout_token_invalid')).toBe(true);
    expect(records.every((r) => String(r.reason).includes('larger than'))).toBe(true);

    // A body at the limit is read in full.
    const padded = `logout_token=${token}&pad=`;
    const atLimit = padded + 'x'.repeat(MAX_BODY_BYTES - padded.length);
    expect(atLimit).toHaveLength(MAX_BODY_BYTES);
    expect((await post(atLimit)).status).toBe(200);
    await expect(store.get(alice.id)).resolves.toBeUndefined();
  });

  it('lets a store failure propagate rather than answering 200', async () => {
    const failing = {
      deleteByLogoutToken: () => Promise.reject(new Error('redis down')),
    };
    const token = await op.sign(logoutClaims());
    await expect(
      handleBackchannelLogout(
        new Request('https://app.test/auth/backchannel-logout', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ logout_token: token }),
        }),
        { client, store: failing },
      ),
    ).rejects.toThrow('redis down');
  });

  it('works without a logger', async () => {
    const token = await op.sign(logoutClaims());
    const response = await handleBackchannelLogout(
      new Request('https://app.test/auth/backchannel-logout', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ logout_token: token }),
      }),
      { client, store },
    );
    expect(response.status).toBe(200);
  });
});
