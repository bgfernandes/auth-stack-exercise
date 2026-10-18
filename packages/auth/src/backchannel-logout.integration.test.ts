/**
 * The sink over the Redis store of the compose stack (`docker compose up -d --wait`; CI's integration job): a
 * token the fake OP signs removes the sessions of that IdP session from Redis, its indexes included, and leaves
 * the others. Zitadel's own delivery of a token is proven in the browser suite (ticket 20) and was observed in
 * the stack when the sink was built (docs/TICKETS.md, ticket 18).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Redis } from 'ioredis';

import { handleBackchannelLogout } from './backchannel-logout';
import { BACKCHANNEL_LOGOUT_EVENT, createOidcClient, type OidcClient } from './oidc';
import { type NewSession, type SessionStore } from './session';
import { createRedisSessionStore } from './stores/redis';
import { createFakeOp, type FakeOp } from './testing/fake-op';

// Not process.loadEnvFile: Jest gives each test file its own copy of `process.env`, and loadEnvFile writes to the real one.
function redisUrl(): string {
  const defaults = parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8'));
  const url = new URL(process.env.REDIS_URL ?? defaults.REDIS_URL ?? 'redis://localhost:6379');
  if (url.hostname === 'redis') url.hostname = 'localhost'; // the compose service name, from the host
  return url.toString();
}

const PREFIX = `it-bcl-${randomUUID().slice(0, 8)}`;
const CLIENT_ID = 'dashboard-web';

describe('back-channel logout against Redis', () => {
  let client: Redis;
  let store: SessionStore;
  let op: FakeOp;
  let oidc: OidcClient;

  beforeAll(async () => {
    client = new Redis(redisUrl());
    store = createRedisSessionStore(client, { prefix: PREFIX });
    op = await createFakeOp({ clientId: CLIENT_ID, projectId: 'project-1' });
    oidc = createOidcClient(
      {
        issuer: op.issuer,
        clientId: CLIENT_ID,
        redirectUri: 'https://app.test/auth/callback',
        postLogoutRedirectUri: 'https://app.test/',
      },
      { fetch: op.fetch, serverMetadata: op.metadata },
    );
  });

  afterAll(async () => {
    const keys = await client.keys(`${PREFIX}:*`);
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  });

  const session = (sub: string, sid: string): NewSession => ({
    sub,
    sid,
    accessToken: `at-${sub}`,
    accessTokenExpiresAt: Date.now() + 600_000,
    amr: ['pwd'],
  });

  it('removes the sessions of the IdP session the token names, with their index entries', async () => {
    const gone1 = await store.create(session('alice', 'sid-gone'));
    const gone2 = await store.create(session('alice', 'sid-gone'));
    const kept = await store.create(session('alice', 'sid-kept'));
    const now = Math.floor(Date.now() / 1000);
    const token = await op.sign({
      iss: op.issuer,
      aud: [CLIENT_ID, 'project-1'],
      iat: now,
      exp: now + 120,
      jti: randomUUID(),
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      sid: 'sid-gone',
      sub: 'alice',
    });

    const response = await handleBackchannelLogout(
      new Request('https://app.test/auth/backchannel-logout', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ logout_token: token }),
      }),
      { client: oidc, store },
    );
    expect(response.status).toBe(200);

    await expect(store.get(gone1.id)).resolves.toBeUndefined();
    await expect(store.get(gone2.id)).resolves.toBeUndefined();
    await expect(store.get(kept.id)).resolves.toMatchObject({ sid: 'sid-kept' });
    await expect(client.exists(`${PREFIX}:sid:sid-gone`)).resolves.toBe(0);
    await expect(client.smembers(`${PREFIX}:user:alice`)).resolves.toEqual([kept.id]);
  });
});
