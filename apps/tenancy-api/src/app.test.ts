/**
 * The routes over an in-memory tenancy service, with tokens from the fake OP of `@auth-stack/auth/testing` and
 * a fake userinfo endpoint: the wire format, the status of each outcome, and that provisioning asks userinfo on
 * the first call for a `sub` only. The real service is covered by its own integration test, and the HTTP client
 * over this app by the client contract (tenancy-api.integration.test.ts).
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { type FastifyInstance } from 'fastify';

import { createBearerVerifier, type ScopeResolver } from '@auth-stack/auth';
import { createFakeOp, type FakeOp } from '@auth-stack/auth/testing';
import {
  TenancyError,
  type Organization,
  type ProvisionClaims,
  type TenancyService,
  type User,
} from '@auth-stack/tenancy';

import { buildApp } from './app';
import { UserinfoError, type UserinfoClient } from './userinfo';

const PROJECT = 'project-1';
const DASHBOARD_WEB = 'dashboard-web';
const READ_ONLY = 'read-only-client';

/** Users, personal organizations, and nothing else: what the three routes of this ticket touch. */
class FakeTenancy implements TenancyService {
  readonly users = new Map<string, User>();
  readonly organizations = new Map<string, Organization>();

  provisionUser(claims: ProvisionClaims): Promise<{
    user: User;
    organization: Organization;
    created: boolean;
  }> {
    let user = this.users.get(claims.sub);
    if (!user) {
      user = {
        id: claims.sub,
        email: claims.email,
        displayName: claims.name,
        createdAt: new Date(),
      };
      this.users.set(claims.sub, user);
    }
    let organization = [...this.organizations.values()].find(
      (candidate) => candidate.isPersonal && candidate.ownerId === claims.sub,
    );
    let created = false;
    if (!organization) {
      organization = {
        id: randomUUID(),
        name: 'Personal',
        isPersonal: true,
        ownerId: claims.sub,
        policy: {},
        createdAt: new Date(),
      };
      this.organizations.set(organization.id, organization);
      created = true;
    }
    return Promise.resolve({ user, organization, created });
  }

  getUser(sub: string): Promise<User | undefined> {
    return Promise.resolve(this.users.get(sub));
  }

  getOrganization(principal: { sub: string }, id: string): Promise<Organization | undefined> {
    const organization = this.organizations.get(id);
    return Promise.resolve(organization?.ownerId === principal.sub ? organization : undefined);
  }

  listOrganizations(principal: { sub: string }): Promise<Organization[]> {
    return Promise.resolve(
      [...this.organizations.values()].filter((candidate) => candidate.ownerId === principal.sub),
    );
  }

  setMembership(): Promise<never> {
    return Promise.reject(new Error('not in this ticket'));
  }

  setPolicy(): Promise<never> {
    return Promise.reject(new Error('not in this ticket'));
  }
}

const scopes: ScopeResolver = {
  resolveScopes: (claims) =>
    Promise.resolve(
      new Set(
        claims.client_id === DASHBOARD_WEB ? ['tenancy:read', 'tenancy:write'] : ['tenancy:read'],
      ),
    ),
};

describe('tenancy-api', () => {
  let op: FakeOp;
  let app: FastifyInstance;
  let service: FakeTenancy;
  /** What userinfo answers per access token, and how often it was asked. */
  const userinfoAnswers = new Map<string, ProvisionClaims | UserinfoError>();
  let userinfoCalls = 0;
  const userinfo: UserinfoClient = {
    claims(accessToken) {
      userinfoCalls += 1;
      const answer = userinfoAnswers.get(accessToken);
      if (!answer) return Promise.reject(new UserinfoError('rejected', 'unknown token'));
      if (answer instanceof UserinfoError) return Promise.reject(answer);
      return Promise.resolve(answer);
    },
  };

  const now = () => Math.floor(Date.now() / 1000);
  /** A token for `sub` issued to `client`, and the userinfo answer that goes with it. */
  async function tokenFor(
    sub: string,
    client = DASHBOARD_WEB,
    answer: ProvisionClaims | UserinfoError = {
      sub,
      email: `${sub}@example.com`,
      name: `User ${sub}`,
    },
  ): Promise<string> {
    const token = await op.sign({
      iss: op.issuer,
      sub,
      aud: [client, PROJECT],
      client_id: client,
      iat: now(),
      exp: now() + 600,
      jti: randomUUID(),
    });
    userinfoAnswers.set(token, answer);
    return token;
  }
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    op = await createFakeOp({ clientId: DASHBOARD_WEB, projectId: PROJECT });
  });

  beforeEach(async () => {
    service = new FakeTenancy();
    userinfoCalls = 0;
    app = await buildApp({
      service,
      verifier: createBearerVerifier({
        issuer: op.issuer,
        audience: PROJECT,
        jwksUrl: op.metadata.jwks_uri as string,
        fetch: op.fetch,
      }),
      scopes,
      userinfo,
      logLevel: 'silent',
    });
    await app.ready();
  });

  afterAll(() => app.close());

  it('serves the health endpoint without a token and denies everything else without one', async () => {
    expect((await app.inject({ url: '/health' })).json()).toEqual({ status: 'ok' });
    const denied = await app.inject({ method: 'POST', url: '/me/provision' });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['www-authenticate']).toBe('Bearer');
  });

  describe('POST /me/provision', () => {
    it('creates the user and the personal organization from userinfo on the first call', async () => {
      const token = await tokenFor('alice');
      const first = await app.inject({
        method: 'POST',
        url: '/me/provision',
        headers: bearer(token),
      });
      expect(first.statusCode).toBe(200);
      const body = first.json<{ organization: Record<string, unknown>; created: boolean }>();
      expect(body.created).toBe(true);
      expect(body.organization).toEqual({
        id: expect.any(String) as unknown,
        name: 'Personal',
        is_personal: true,
        policy: {},
      });
      expect(service.users.get('alice')).toMatchObject({
        email: 'alice@example.com',
        displayName: 'User alice',
      });
      expect(userinfoCalls).toBe(1);
    });

    it('is idempotent and does not ask userinfo again once the row exists', async () => {
      const first = await app.inject({
        method: 'POST',
        url: '/me/provision',
        headers: bearer(await tokenFor('alice')),
      });
      const second = await app.inject({
        method: 'POST',
        url: '/me/provision',
        headers: bearer(await tokenFor('alice', DASHBOARD_WEB, new UserinfoError('rejected', 'x'))),
      });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ ...first.json<object>(), created: false });
      expect(userinfoCalls).toBe(1);
    });

    it('needs tenancy:write', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/me/provision',
        headers: bearer(await tokenFor('alice', READ_ONLY)),
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['www-authenticate']).toBe(
        'Bearer error="insufficient_scope", scope="tenancy:write"',
      );
      expect(service.users.size).toBe(0);
    });

    it('answers 401 when userinfo refuses the token and 502 when it cannot answer', async () => {
      const refused = await app.inject({
        method: 'POST',
        url: '/me/provision',
        headers: bearer(
          await tokenFor('alice', DASHBOARD_WEB, new UserinfoError('rejected', 'no')),
        ),
      });
      expect(refused.statusCode).toBe(401);
      expect(refused.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
      expect(refused.json()).toEqual({ error: 'invalid_token' });

      const down = await app.inject({
        method: 'POST',
        url: '/me/provision',
        headers: bearer(
          await tokenFor('alice', DASHBOARD_WEB, new UserinfoError('unavailable', 'timeout')),
        ),
      });
      expect(down.statusCode).toBe(502);
      expect(down.json()).toEqual({ error: 'userinfo_unavailable' });
      expect(service.users.size).toBe(0);
    });

    it('keeps the status of a request Fastify itself refuses, with the generic body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/me/provision',
        headers: {
          ...bearer(await tokenFor('alice')),
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: 'a=1',
      });
      expect(response.statusCode).toBe(415);
      expect(response.json()).toEqual({ error: 'bad_request' });
    });

    it('refuses a userinfo answer about another subject', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/me/provision',
        headers: bearer(
          await tokenFor('alice', DASHBOARD_WEB, { sub: 'mallory', email: 'm@x', name: 'M' }),
        ),
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'internal' });
      expect(service.users.size).toBe(0);
    });
  });

  describe('organizations', () => {
    let alice: string;
    let bob: string;
    let personal: string;

    beforeEach(async () => {
      alice = await tokenFor('alice');
      bob = await tokenFor('bob');
      const provisioned = await app.inject({
        method: 'POST',
        url: '/me/provision',
        headers: bearer(alice),
      });
      personal = provisioned.json<{ organization: { id: string } }>().organization.id;
    });

    it('lists the organizations the caller may view, in the wire format', async () => {
      const response = await app.inject({ url: '/me/organizations', headers: bearer(alice) });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        organizations: [{ id: personal, name: 'Personal', is_personal: true, policy: {} }],
      });
      expect((await app.inject({ url: '/me/organizations', headers: bearer(bob) })).json()).toEqual(
        { organizations: [] },
      );
    });

    it('returns one organization to a viewer and 404 to anyone else, for any ID', async () => {
      const own = await app.inject({ url: `/organizations/${personal}`, headers: bearer(alice) });
      expect(own.json()).toEqual({ id: personal, name: 'Personal', is_personal: true, policy: {} });
      for (const [token, id] of [
        [bob, personal],
        [alice, randomUUID()],
        [alice, 'not-a-uuid'],
      ] as const) {
        const response = await app.inject({ url: `/organizations/${id}`, headers: bearer(token) });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'not_found' });
      }
    });

    it('needs tenancy:read on both routes', async () => {
      const token = await tokenFor('alice', READ_ONLY);
      expect(
        (await app.inject({ url: '/me/organizations', headers: bearer(token) })).statusCode,
      ).toBe(200);
      // The read-only client holds tenancy:read; a client with nothing gets 403 on the reads too.
      const none: ScopeResolver = { resolveScopes: () => Promise.resolve(new Set()) };
      const bare = await buildApp({
        service,
        verifier: createBearerVerifier({
          issuer: op.issuer,
          audience: PROJECT,
          jwksUrl: op.metadata.jwks_uri as string,
          fetch: op.fetch,
        }),
        scopes: none,
        userinfo,
        logLevel: 'silent',
      });
      const response = await bare.inject({ url: '/me/organizations', headers: bearer(token) });
      expect(response.statusCode).toBe(403);
      expect(response.headers['www-authenticate']).toBe(
        'Bearer error="insufficient_scope", scope="tenancy:read"',
      );
      await bare.close();
    });
  });

  describe('errors', () => {
    it('maps TenancyError codes to statuses and hides everything else behind a 500', async () => {
      const failing = {
        ...service,
        getUser: service.getUser.bind(service),
        provisionUser: service.provisionUser.bind(service),
        listOrganizations: () => Promise.reject(new Error('database on fire')),
        getOrganization: () => Promise.reject(new TenancyError('forbidden', 'not yours')),
      } as unknown as TenancyService;
      const broken = await buildApp({
        service: failing,
        verifier: createBearerVerifier({
          issuer: op.issuer,
          audience: PROJECT,
          jwksUrl: op.metadata.jwks_uri as string,
          fetch: op.fetch,
        }),
        scopes,
        userinfo,
        logLevel: 'silent',
      });
      const token = await tokenFor('alice');
      const forbidden = await broken.inject({
        url: `/organizations/${randomUUID()}`,
        headers: bearer(token),
      });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toEqual({ error: 'forbidden' });
      const internal = await broken.inject({ url: '/me/organizations', headers: bearer(token) });
      expect(internal.statusCode).toBe(500);
      expect(internal.body).toBe('{"error":"internal"}');
      await broken.close();
    });
  });
});
