/**
 * Against the compose stack: the real tenancy service on a database of its own (`it_tenancy_api`) and the
 * compose SpiceDB, including the SpiceDB-backed scope resolver with grants written for a client of this run.
 * Tokens come from the fake OP (no Zitadel login in a test), userinfo is a fake keyed by token, and the HTTP
 * `TenancyClient` reaches the app through Fastify's `inject`, so the contract it runs is the one the BFFs get.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { afterAll, beforeAll } from '@jest/globals';
import { type FastifyInstance } from 'fastify';

import { createBearerVerifier } from '@auth-stack/auth';
import { createFakeOp, type FakeOp } from '@auth-stack/auth/testing';
import {
  authzOptionsFromEnv,
  createAuthz,
  fullyConsistent,
  relationship,
  touch,
  type Authz,
} from '@auth-stack/authz';
import { ensureSchema } from '@auth-stack/authz/schema';
import { apiScope, client, createScopeResolver } from '@auth-stack/client-scopes';
import {
  adminUrlFromEnv,
  createTestDatabase,
  type TestDatabase,
} from '@auth-stack/db-core/testing';
import {
  createHttpTenancyClient,
  createTenancyService,
  schema,
  TENANCY_API_SCOPES,
  type ProvisionClaims,
  type TenancySchema,
} from '@auth-stack/tenancy';
import { describeTenancyClientContract } from '@auth-stack/tenancy/testing';

import { buildApp } from './app';
import { UserinfoError } from './userinfo';

function loadStackDefaults(): void {
  const defaults = parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8'));
  for (const key of [
    'SPICEDB_PRESHARED_KEY',
    'SPICEDB_INSECURE',
    'POSTGRES_ADMIN_USER',
    'POSTGRES_ADMIN_PASSWORD',
  ]) {
    process.env[key] ??= defaults[key];
  }
  process.env.SPICEDB_ENDPOINT ??= 'localhost:50051';
}

const RUN = randomUUID().slice(0, 8);
const PROJECT = `it-${RUN}-project`;
const CLIENT = `it-${RUN}-dashboard-web`;

let op: FakeOp;
let authz: Authz;
let database: TestDatabase<TenancySchema>;
let app: FastifyInstance;
const organizationIds = new Set<string>();
const userinfoAnswers = new Map<string, ProvisionClaims>();

/** `fetch` over `app.inject`: the client's requests reach the app without a listening socket. */
const injectFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const response = await app.inject({
    method: (init?.method ?? 'GET').toUpperCase(),
    url,
    headers,
  });
  const responseHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (typeof value === 'string') responseHeaders[key] = value;
  }
  return new Response(response.body, { status: response.statusCode, headers: responseHeaders });
};

beforeAll(async () => {
  loadStackDefaults();
  op = await createFakeOp({ clientId: CLIENT, projectId: PROJECT });
  authz = createAuthz(authzOptionsFromEnv());
  await ensureSchema(authz);
  await authz.writeRelationships(
    Object.values(TENANCY_API_SCOPES).map((scope) =>
      touch(relationship(apiScope(scope), 'grantee', client(CLIENT))),
    ),
  );
  database = await createTestDatabase({
    adminUrl: adminUrlFromEnv(),
    name: 'it_tenancy_api',
    schema,
    migrationsFolder: new URL('../../../packages/tenancy/migrations', import.meta.url).pathname,
  });
  app = await buildApp({
    service: createTenancyService({ db: database.db, authz }),
    verifier: createBearerVerifier({
      issuer: op.issuer,
      audience: PROJECT,
      jwksUrl: op.metadata.jwks_uri as string,
      fetch: op.fetch,
    }),
    // The grants were just written, so the lookup must see them: full consistency instead of the default.
    scopes: createScopeResolver(authz, { consistency: fullyConsistent }),
    userinfo: {
      claims(accessToken) {
        const answer = userinfoAnswers.get(accessToken);
        return answer
          ? Promise.resolve(answer)
          : Promise.reject(new UserinfoError('rejected', 'unknown token'));
      },
    },
    logLevel: 'silent',
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const id of organizationIds) {
    await authz.deleteRelationships({ resourceType: 'organization', resourceId: id });
  }
  await authz.deleteRelationships({
    resourceType: 'api_scope',
    subject: { type: 'client', id: CLIENT },
  });
  await database.drop();
  authz.close();
});

describeTenancyClientContract('http', () => ({
  client: createHttpTenancyClient({ baseUrl: 'http://tenancy-api.test', fetch: injectFetch }),
  async user(name) {
    const sub = `it-${RUN}-${name}`;
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await op.sign({
      iss: op.issuer,
      sub,
      aud: [CLIENT, PROJECT],
      client_id: CLIENT,
      iat: now,
      exp: now + 600,
      jti: randomUUID(),
    });
    userinfoAnswers.set(accessToken, { sub, email: `${name}@example.com`, name });
    return { sub, accessToken };
  },
  track: (id) => organizationIds.add(id),
}));
