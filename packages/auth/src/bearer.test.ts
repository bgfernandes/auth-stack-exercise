/** Bearer verification against tokens the fake OP signs: the valid shape, and every way a token is refused. */
import { beforeAll, describe, expect, it } from '@jest/globals';

import {
  assertScopeStrings,
  BearerError,
  bearerOptionsFromEnv,
  createBearerVerifier,
  fromScopeClaim,
  requireScopes,
  type BearerVerifier,
  type Principal,
} from './bearer';
import { createFakeOp, type FakeOp } from './testing/fake-op';

const PROJECT = 'project-1';
const CLIENT = 'tenancy-web';

async function refused(promise: Promise<unknown>): Promise<BearerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BearerError) return error;
    throw error;
  }
  throw new Error('expected a BearerError');
}

describe('createBearerVerifier', () => {
  let op: FakeOp;
  let verifier: BearerVerifier;
  const now = () => Math.floor(Date.now() / 1000);
  const accessToken = (overrides: Record<string, unknown> = {}, header: { typ?: string } = {}) =>
    op.sign(
      {
        iss: op.issuer,
        sub: 'alice',
        aud: [CLIENT, PROJECT],
        client_id: CLIENT,
        iat: now(),
        exp: now() + 600,
        jti: 'at-1',
        ...overrides,
      },
      header,
    );

  beforeAll(async () => {
    op = await createFakeOp({ clientId: CLIENT, projectId: PROJECT });
    verifier = createBearerVerifier({
      issuer: op.issuer,
      audience: PROJECT,
      jwksUrl: op.metadata.jwks_uri as string,
      fetch: op.fetch,
    });
  });

  it('accepts a token of the issuer for the project and names its subject and client', async () => {
    const principal = await verifier.verify(`Bearer ${await accessToken()}`);
    expect(principal).toMatchObject({ sub: 'alice', clientId: CLIENT });
    expect(principal.claims.jti).toBe('at-1');
    await expect(
      verifier.verify(`bearer ${await accessToken({}, { typ: 'at+jwt' })}`),
    ).resolves.toBeDefined();
  });

  it('refuses a missing header as missing_token, with the bare challenge', async () => {
    const error = await refused(verifier.verify(undefined));
    expect(error.code).toBe('missing_token');
    expect(error.status).toBe(401);
    expect(error.challenge).toBe('Bearer');
  });

  it('refuses another scheme, a malformed token, and a token signed by another key', async () => {
    for (const header of [
      'Basic abc',
      'Bearer',
      'Bearer not.a.jwt',
      `Bearer ${await accessToken()}x`,
    ]) {
      const error = await refused(verifier.verify(header));
      expect(error.code).toBe('invalid_token');
      expect(error.challenge).toBe('Bearer error="invalid_token"');
    }
    const other = await createFakeOp({ clientId: CLIENT, projectId: PROJECT });
    const foreign = await other.sign({
      iss: op.issuer,
      sub: 'alice',
      aud: PROJECT,
      client_id: CLIENT,
      exp: now() + 600,
    });
    expect((await refused(verifier.verify(`Bearer ${foreign}`))).code).toBe('invalid_token');
  });

  it('refuses an expired token, another issuer, and an audience without the project', async () => {
    for (const overrides of [
      { exp: now() - 60 },
      { iss: 'https://other.test' },
      { aud: CLIENT },
      { aud: ['other-project'] },
    ]) {
      const error = await refused(verifier.verify(`Bearer ${await accessToken(overrides)}`));
      expect(error.code).toBe('invalid_token');
    }
  });

  it('refuses an ID token of the same issuer, and tokens without a subject or client', async () => {
    const idToken = await accessToken({
      at_hash: 'x',
      azp: CLIENT,
      auth_time: now(),
      amr: ['pwd'],
    });
    expect((await refused(verifier.verify(`Bearer ${idToken}`))).message).toContain('ID token');
    for (const overrides of [{ nonce: 'n' }, { sub: undefined }, { client_id: undefined }]) {
      expect((await refused(verifier.verify(`Bearer ${await accessToken(overrides)}`))).code).toBe(
        'invalid_token',
      );
    }
    const logoutToken = await accessToken({}, { typ: 'logout+jwt' });
    expect((await refused(verifier.verify(`Bearer ${logoutToken}`))).message).toContain(
      'logout+jwt',
    );
  });

  it('does not call a token invalid when the JWKS cannot be fetched or is not a key set', async () => {
    for (const fetch of [
      () => Promise.reject(new Error('connection refused')),
      () => Promise.resolve(new Response('upstream error', { status: 502 })),
    ]) {
      const down = createBearerVerifier({
        issuer: op.issuer,
        audience: PROJECT,
        jwksUrl: 'https://op.test/jwks',
        fetch,
      });
      await expect(down.verify(`Bearer ${await accessToken()}`)).rejects.not.toBeInstanceOf(
        BearerError,
      );
    }
  });

  it('the error message never carries the token', async () => {
    const token = await accessToken({ exp: now() - 60 });
    const error = await refused(verifier.verify(`Bearer ${token}`));
    expect(error.message).not.toContain(token.slice(0, 20));
  });
});

describe('scopes', () => {
  const principal = (scope?: string): Principal => ({
    sub: 'alice',
    clientId: CLIENT,
    claims: { sub: 'alice', client_id: CLIENT, ...(scope === undefined ? {} : { scope }) },
  });

  it('fromScopeClaim reads the scope claim, empty when absent', async () => {
    await expect(
      fromScopeClaim.resolveScopes(principal('tenancy:read  tenancy:write').claims),
    ).resolves.toEqual(new Set(['tenancy:read', 'tenancy:write']));
    await expect(fromScopeClaim.resolveScopes(principal().claims)).resolves.toEqual(new Set());
  });

  it('requireScopes passes with every scope granted and fails with the required set in the challenge', async () => {
    await expect(
      requireScopes(principal('tenancy:read tenancy:write'), fromScopeClaim, ['tenancy:write']),
    ).resolves.toBeUndefined();
    const error = await refused(
      requireScopes(principal('tenancy:read'), fromScopeClaim, ['tenancy:read', 'tenancy:write']),
    );
    expect(error.code).toBe('insufficient_scope');
    expect(error.status).toBe(403);
    expect(error.challenge).toBe(
      'Bearer error="insufficient_scope", scope="tenancy:read tenancy:write"',
    );
  });

  it('assertScopeStrings rejects anything but <api>:<verb>', () => {
    expect(() => assertScopeStrings(['tenancy:read', 'documents:write'])).not.toThrow();
    for (const scope of [
      'tenancy',
      'tenancy:',
      ':read',
      'Tenancy:Read',
      'a:b:c',
      'tenancy_read',
      'tenancy:read ',
    ]) {
      expect(() => assertScopeStrings([scope])).toThrow('invalid API scope');
    }
  });
});

describe('bearerOptionsFromEnv', () => {
  it('reads the three values of apis.env and fails on a missing one', () => {
    expect(
      bearerOptionsFromEnv({
        OIDC_ISSUER: 'https://auth.localtest.me:8443',
        OIDC_PROJECT_ID: 'p',
        OIDC_JWKS_URL: 'https://auth.localtest.me:8443/oauth/v2/keys',
      }),
    ).toEqual({
      issuer: 'https://auth.localtest.me:8443',
      audience: 'p',
      jwksUrl: 'https://auth.localtest.me:8443/oauth/v2/keys',
    });
    expect(() => bearerOptionsFromEnv({ OIDC_ISSUER: 'x', OIDC_JWKS_URL: 'y' })).toThrow(
      'OIDC_PROJECT_ID',
    );
  });
});
