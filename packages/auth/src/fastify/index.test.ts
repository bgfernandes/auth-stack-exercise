/** The plugin on a real Fastify instance with `inject`: deny by default, the gate, the responses, the request IDs. */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';

import { createBearerVerifier, fromScopeClaim, type ScopeResolver } from '../bearer';
import { createFakeOp, type FakeOp } from '../testing/fake-op';

import { apiServerOptions, bearerPlugin, echoRequestId } from './index';

const PROJECT = 'project-1';

describe('bearerPlugin', () => {
  let op: FakeOp;
  let app: FastifyInstance;
  const registry: ScopeResolver = {
    resolveScopes: (claims) =>
      Promise.resolve(
        new Set(
          claims.client_id === 'first-party' ? ['tenancy:read', 'tenancy:write'] : ['tenancy:read'],
        ),
      ),
  };
  const now = () => Math.floor(Date.now() / 1000);
  const token = (client: string, extra: Record<string, unknown> = {}) =>
    op.sign({
      iss: op.issuer,
      sub: 'alice',
      aud: [client, PROJECT],
      client_id: client,
      iat: now(),
      exp: now() + 600,
      ...extra,
    });

  beforeAll(async () => {
    op = await createFakeOp({ clientId: 'first-party', projectId: PROJECT });
    app = Fastify({ ...apiServerOptions(), logger: false });
    echoRequestId(app);
    await app.register(bearerPlugin, {
      verifier: createBearerVerifier({
        issuer: op.issuer,
        audience: PROJECT,
        jwksUrl: op.metadata.jwks_uri as string,
        fetch: op.fetch,
      }),
      scopes: registry,
    });
    app.get('/health', { config: { public: true } }, () => ({ ok: true }));
    app.get('/me', () => ({ ok: true }));
    app.get('/organizations', { preHandler: app.requireScope('tenancy:read') }, (request) => ({
      sub: request.principal?.sub,
      client: request.principal?.clientId,
    }));
    app.post('/organizations', { preHandler: app.requireScope('tenancy:write') }, () => ({
      ok: true,
    }));
    await app.ready();
  });
  afterAll(() => app.close());

  it('lets a public route through without a token and denies every other route by default', async () => {
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    const denied = await app.inject({ url: '/me' });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['www-authenticate']).toBe('Bearer');
    expect(denied.json()).toEqual({ error: 'missing_token' });
  });

  it('answers an invalid token with 401 and the invalid_token challenge, saying nothing more', async () => {
    const response = await app.inject({
      url: '/me',
      headers: { authorization: `Bearer ${await token('first-party', { exp: now() - 120 })}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(response.body).toBe('{"error":"invalid_token"}');
  });

  it('puts the principal on the request and gates routes on the client scopes', async () => {
    const read = await app.inject({
      url: '/organizations',
      headers: { authorization: `Bearer ${await token('first-party')}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ sub: 'alice', client: 'first-party' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/organizations',
          headers: { authorization: `Bearer ${await token('first-party')}` },
        })
      ).statusCode,
    ).toBe(200);

    const limited = await token('third-party');
    expect(
      (await app.inject({ url: '/organizations', headers: { authorization: `Bearer ${limited}` } }))
        .statusCode,
    ).toBe(200);
    const forbidden = await app.inject({
      method: 'POST',
      url: '/organizations',
      headers: { authorization: `Bearer ${limited}` },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.headers['www-authenticate']).toBe(
      'Bearer error="insufficient_scope", scope="tenancy:write"',
    );
    expect(forbidden.json()).toEqual({ error: 'insufficient_scope' });
  });

  it('rejects a misspelled scope when the route is declared, not at request time', () => {
    expect(() => app.requireScope('tenancy_write')).toThrow('invalid API scope');
  });

  it('keeps a well-formed inbound request ID and replaces anything else', async () => {
    const kept = await app.inject({ url: '/health', headers: { 'x-request-id': 'bff-123.abc' } });
    expect(kept.headers['x-request-id']).toBe('bff-123.abc');
    const replaced = await app.inject({ url: '/health', headers: { 'x-request-id': 'not ok\n' } });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect((await app.inject({ url: '/health' })).headers['x-request-id']).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('works with the scope claim resolver for a provider that emits scope', async () => {
    const claimApp = Fastify({ logger: false });
    await claimApp.register(bearerPlugin, {
      verifier: createBearerVerifier({
        issuer: op.issuer,
        audience: PROJECT,
        jwksUrl: op.metadata.jwks_uri as string,
        fetch: op.fetch,
      }),
      scopes: fromScopeClaim,
    });
    claimApp.get('/organizations', { preHandler: claimApp.requireScope('tenancy:read') }, () => ({
      ok: true,
    }));
    await claimApp.ready();
    expect(
      (
        await claimApp.inject({
          url: '/organizations',
          headers: { authorization: `Bearer ${await token('x', { scope: 'tenancy:read' })}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await claimApp.inject({
          url: '/organizations',
          headers: { authorization: `Bearer ${await token('x', { scope: 'tenancy:write' })}` },
        })
      ).statusCode,
    ).toBe(403);
    await claimApp.close();
  });

  it('answers a resolver or JWKS failure as a server error, not as a bad token', async () => {
    const broken = Fastify({ logger: false });
    await broken.register(bearerPlugin, {
      verifier: createBearerVerifier({
        issuer: op.issuer,
        audience: PROJECT,
        jwksUrl: op.metadata.jwks_uri as string,
        fetch: op.fetch,
      }),
      scopes: { resolveScopes: () => Promise.reject(new Error('SpiceDB unavailable')) },
    });
    broken.get('/organizations', { preHandler: broken.requireScope('tenancy:read') }, () => ({
      ok: true,
    }));
    await broken.ready();
    const response = await broken.inject({
      url: '/organizations',
      headers: { authorization: `Bearer ${await token('first-party')}` },
    });
    expect(response.statusCode).toBe(500);
    expect(response.headers['www-authenticate']).toBeUndefined();
    await broken.close();

    const noJwks = Fastify({ logger: false });
    await noJwks.register(bearerPlugin, {
      verifier: createBearerVerifier({
        issuer: op.issuer,
        audience: PROJECT,
        jwksUrl: 'https://op.test/jwks',
        fetch: () => Promise.reject(new Error('connection refused')),
      }),
      scopes: registry,
    });
    noJwks.get('/me', () => ({ ok: true }));
    await noJwks.ready();
    const down = await noJwks.inject({
      url: '/me',
      headers: { authorization: `Bearer ${await token('first-party')}` },
    });
    expect(down.statusCode).toBe(500);
    expect(down.headers['www-authenticate']).toBeUndefined();
    await noJwks.close();
  });

  it('redacts the credential headers in the log options', () => {
    const options = apiServerOptions({ logLevel: 'debug' });
    expect(options.logger).toMatchObject({ level: 'debug', redact: { censor: '[redacted]' } });
    expect((options.logger as { redact: { paths: string[] } }).redact.paths).toEqual(
      expect.arrayContaining(['req.headers.authorization', 'req.headers.cookie']),
    );
  });
});
