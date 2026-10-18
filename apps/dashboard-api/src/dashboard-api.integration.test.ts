/**
 * Against the compose stack: the real documents service on a database of its own (`it_dashboard_api`) and the
 * compose SpiceDB, including the SpiceDB-backed scope resolver with grants written for a client of this run.
 * Tokens come from the fake OP (no Zitadel login in a test) and tenancy is a fake `TenancyClient`, since the
 * integration job runs the infrastructure without the apps. What it proves is the ticket's acceptance: the
 * three states of §6.5 as HTTP statuses, the share action, and the personal workspace, over the real checks.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { type FastifyInstance } from 'fastify';

import { createBearerVerifier } from '@auth-stack/auth';
import { createFakeOp, type FakeOp } from '@auth-stack/auth/testing';
import {
  authzOptionsFromEnv,
  createAuthz,
  fullyConsistent,
  ref,
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
  createDocumentsService,
  documents,
  projects,
  schema,
  type DocumentsSchema,
} from '@auth-stack/documents';
import { DOCUMENTS_API_SCOPES, type DocumentWire } from '@auth-stack/documents/client';
import { type OrganizationSummary, type TenancyClient } from '@auth-stack/tenancy/client';

import { buildApp } from './app';

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
const ACME = randomUUID();
const sub = (name: string) => `it-${RUN}-${name}`;

const fakeTenancy: TenancyClient = {
  provisionUser: () => Promise.reject(new Error('not used here')),
  getOrganization: (_user, id) => {
    const known: Record<string, OrganizationSummary> = {
      [ACME]: { id: ACME, name: 'Acme', isPersonal: false, policy: {} },
    };
    return Promise.resolve(known[id]);
  },
  listOrganizations: () => Promise.reject(new Error('not used here')),
};

let op: FakeOp;
let authz: Authz;
let database: TestDatabase<DocumentsSchema>;
let app: FastifyInstance;
const tokens = new Map<string, string>();

beforeAll(async () => {
  loadStackDefaults();
  op = await createFakeOp({ clientId: CLIENT, projectId: PROJECT });
  authz = createAuthz(authzOptionsFromEnv());
  await ensureSchema(authz);
  await authz.writeRelationships([
    ...Object.values(DOCUMENTS_API_SCOPES).map((scope) =>
      touch(relationship(apiScope(scope), 'grantee', client(CLIENT))),
    ),
    // Alice administers Acme; Bob and Carol are members, who see nothing by that alone (§6.2).
    touch(relationship(ref('organization', ACME), 'admin', ref('user', sub('alice')))),
    touch(relationship(ref('organization', ACME), 'member', ref('user', sub('bob')))),
    touch(relationship(ref('organization', ACME), 'member', ref('user', sub('carol')))),
  ]);
  database = await createTestDatabase({
    adminUrl: adminUrlFromEnv(),
    name: 'it_dashboard_api',
    schema,
    migrationsFolder: new URL('../../../packages/documents/migrations', import.meta.url).pathname,
  });
  app = await buildApp({
    service: createDocumentsService({ db: database.db, authz, tenancy: fakeTenancy }),
    verifier: createBearerVerifier({
      issuer: op.issuer,
      audience: PROJECT,
      jwksUrl: op.metadata.jwks_uri as string,
      fetch: op.fetch,
    }),
    // The grants were just written, so the lookup must see them: full consistency instead of the default.
    scopes: createScopeResolver(authz, { consistency: fullyConsistent }),
    logLevel: 'silent',
  });
  await app.ready();
  const now = Math.floor(Date.now() / 1000);
  for (const name of ['alice', 'bob', 'carol', 'dave']) {
    tokens.set(
      name,
      await op.sign({
        iss: op.issuer,
        sub: sub(name),
        aud: [CLIENT, PROJECT],
        client_id: CLIENT,
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
      }),
    );
  }
});

afterAll(async () => {
  await app.close();
  for (const { id } of await database.db.select({ id: documents.id }).from(documents)) {
    await authz.deleteRelationships({ resourceType: 'document', resourceId: id });
  }
  for (const { id } of await database.db.select({ id: projects.id }).from(projects)) {
    await authz.deleteRelationships({ resourceType: 'project', resourceId: id });
  }
  await authz.deleteRelationships({ resourceType: 'organization', resourceId: ACME });
  await authz.deleteRelationships({
    resourceType: 'api_scope',
    subject: { type: 'client', id: CLIENT },
  });
  await database.drop();
  authz.close();
});

const as = (name: string) => ({ authorization: `Bearer ${tokens.get(name) ?? ''}` });
/** A request with a body: Fastify refuses an empty body declared as JSON, so the type travels with one only. */
const json = (name: string) => ({ ...as(name), 'content-type': 'application/json' });

describe('dashboard-api against the stack', () => {
  let welcome: DocumentWire;

  it('creates the personal workspace for an organization admin, once', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/organizations/${ACME}/personal-project`,
      headers: as('alice'),
    });
    expect(first.statusCode).toBe(200);
    const body = first.json<{
      project: { id: string };
      document: DocumentWire;
      created: boolean;
    }>();
    expect(body.created).toBe(true);
    expect(body.document).toMatchObject({
      project_id: body.project.id,
      organization_id: ACME,
      name: 'Welcome',
      value_1: 'Hello',
      value_2: 'World',
      updated_by: sub('alice'),
    });
    welcome = body.document;
    const second = await app.inject({
      method: 'POST',
      url: `/organizations/${ACME}/personal-project`,
      headers: as('alice'),
    });
    expect(second.json()).toEqual({ ...body, created: false });
    // Members may create projects too (§6.2), and get the same, single personal project of the organization.
    const asBob = await app.inject({
      method: 'POST',
      url: `/organizations/${ACME}/personal-project`,
      headers: as('bob'),
    });
    expect(asBob.json()).toEqual({ ...body, created: false });
    const elsewhere = await app.inject({
      method: 'POST',
      url: `/organizations/${randomUUID()}/personal-project`,
      headers: as('alice'),
    });
    expect(elsewhere.statusCode).toBe(404);
  });

  it('shares the document and shows the three states as statuses', async () => {
    // Before any share: only Alice sees it.
    for (const name of ['bob', 'carol']) {
      expect((await app.inject({ url: '/documents', headers: as(name) })).json()).toEqual({
        documents: [],
      });
      expect(
        (await app.inject({ url: `/documents/${welcome.id}`, headers: as(name) })).statusCode,
      ).toBe(404);
    }

    // Alice shares it: Bob may view, Carol may edit; the token stored by the share makes the next reads see it.
    const shared = await app.inject({
      method: 'PUT',
      url: `/documents/${welcome.id}/shares`,
      headers: json('alice'),
      payload: { editors: [sub('carol')], viewers: [sub('bob')] },
    });
    expect(shared.statusCode).toBe(200);
    expect(shared.json()).toEqual(welcome);

    const list = async (name: string) =>
      (await app.inject({ url: '/documents', headers: as(name) }))
        .json<{ documents: { id: string; can_edit: boolean; organization: { name: string } }[] }>()
        .documents.map((row) => [row.id, row.can_edit, row.organization.name]);
    expect(await list('alice')).toEqual([[welcome.id, true, 'Acme']]);
    expect(await list('bob')).toEqual([[welcome.id, false, 'Acme']]);
    expect(await list('carol')).toEqual([[welcome.id, true, 'Acme']]);
    expect(await list('dave')).toEqual([]);

    const read = async (name: string) =>
      (await app.inject({ url: `/documents/${welcome.id}`, headers: as(name) })).statusCode;
    expect(await read('alice')).toBe(200);
    expect(await read('carol')).toBe(200);
    expect(await read('bob')).toBe(403);
    expect(await read('dave')).toBe(404);

    const write = async (name: string, values: { value_1: string; value_2: string }) =>
      app.inject({
        method: 'PUT',
        url: `/documents/${welcome.id}`,
        headers: json(name),
        payload: values,
      });
    const denied = await write('bob', { value_1: 'crafted', value_2: 'crafted' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'forbidden' });
    const unseen = await write('dave', { value_1: 'crafted', value_2: 'crafted' });
    expect(unseen.statusCode).toBe(404);
    expect(unseen.json()).toEqual({ error: 'not_found' });
    const edited = await write('carol', { value_1: 'Goodbye', value_2: 'Moon' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({
      value_1: 'Goodbye',
      value_2: 'Moon',
      updated_by: sub('carol'),
    });
    const after = await app.inject({ url: `/documents/${welcome.id}`, headers: as('alice') });
    expect(after.json()).toEqual(edited.json());

    // Sharing is for whoever may share: the editor by share gets 403, the viewer too, a stranger 404.
    for (const [name, status] of [
      ['carol', 403],
      ['bob', 403],
      ['dave', 404],
    ] as const) {
      const response = await app.inject({
        method: 'PUT',
        url: `/documents/${welcome.id}/shares`,
        headers: json(name),
        payload: { editors: [], viewers: [] },
      });
      expect(response.statusCode).toBe(status);
    }
    // Member IDs only (§6.8): Dave is no member of Acme.
    const outsider = await app.inject({
      method: 'PUT',
      url: `/documents/${welcome.id}/shares`,
      headers: json('alice'),
      payload: { editors: [sub('dave')], viewers: [] },
    });
    expect(outsider.statusCode).toBe(400);
    expect(outsider.json()).toEqual({ error: 'not_a_member' });

    // The replacement drops Bob and keeps Carol.
    const replaced = await app.inject({
      method: 'PUT',
      url: `/documents/${welcome.id}/shares`,
      headers: json('alice'),
      payload: { editors: [sub('carol')], viewers: [] },
    });
    expect(replaced.statusCode).toBe(200);
    expect(await read('bob')).toBe(404);
    expect(await read('carol')).toBe(200);
    expect(await list('bob')).toEqual([]);
  });
});
