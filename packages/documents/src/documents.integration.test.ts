/**
 * Against the compose stack (`docker compose up -d --wait`; CI's integration job): a database of its own,
 * `it_documents`, migrated from zero on the stack's Postgres, and the compose SpiceDB with an organization and
 * subjects unique to this run. Tenancy is a fake `TenancyClient`, the way the package is wired in tests.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { eq, sql } from 'drizzle-orm';
import { ZodError } from 'zod';

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
import {
  adminUrlFromEnv,
  createTestDatabase,
  type TestDatabase,
} from '@auth-stack/db-core/testing';
import { type OrganizationSummary, type TenancyClient } from '@auth-stack/tenancy/client';

import { documents, projects, schema, type DocumentsSchema } from './schema.js';

import { createDocumentsService, type DocumentsService } from './index.js';

// Not process.loadEnvFile: Jest gives each test file its own copy of `process.env`, and loadEnvFile writes to the real one.
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
const user = (name: string) => ({ sub: `it-${RUN}-${name}`, accessToken: 'unused' });
const alice = user('alice');
const bob = user('bob');
const carol = user('carol');
const ACME = randomUUID();

const fakeTenancy: TenancyClient = {
  provisionUser: () => Promise.reject(new Error('not used here')),
  getOrganization: (_user, id) => {
    const acme: OrganizationSummary = { id: ACME, name: 'Acme', isPersonal: false, policy: {} };
    return Promise.resolve(id === ACME ? acme : undefined);
  },
  listOrganizations: () => Promise.reject(new Error('not used here')),
};

let authz: Authz;
let database: TestDatabase<DocumentsSchema>;
let service: DocumentsService;

beforeAll(async () => {
  loadStackDefaults();
  authz = createAuthz(authzOptionsFromEnv());
  await ensureSchema(authz);
  database = await createTestDatabase({
    adminUrl: adminUrlFromEnv(),
    name: 'it_documents',
    schema,
    migrationsFolder: new URL('../migrations', import.meta.url).pathname,
  });
  service = createDocumentsService({ db: database.db, authz, tenancy: fakeTenancy });
  // Alice administers Acme (tenancy's part of the schema); Bob is a plain member and sees no project by that alone.
  await authz.writeRelationships([
    touch(relationship(ref('organization', ACME), 'admin', ref('user', alice.sub))),
    touch(relationship(ref('organization', ACME), 'member', ref('user', bob.sub))),
  ]);
});

afterAll(async () => {
  const rows = await database.db.select({ id: projects.id }).from(projects);
  for (const { id } of rows) {
    await authz.deleteRelationships({ resourceType: 'document', subject: { type: 'project', id } });
    await authz.deleteRelationships({ resourceType: 'project', resourceId: id });
  }
  await authz.deleteRelationships({ resourceType: 'organization', resourceId: ACME });
  await database.drop();
  authz.close();
});

describe('migrations', () => {
  it('created the tables and recorded the migration', async () => {
    const tables = await database.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(tables.map((row) => row.table_name)).toEqual(['documents', 'projects']);
    const applied = await database.db.execute<{ count: string }>(
      sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
    );
    expect(applied[0]?.count).toBe('1');
  });
});

describe('ensurePersonalProject', () => {
  it('creates the project and the example document once, with the write token stored', async () => {
    const first = await service.ensurePersonalProject(alice, ACME);
    expect(first.created).toBe(true);
    expect(first.project).toMatchObject({
      organizationId: ACME,
      name: 'Personal',
      isPersonal: true,
    });
    expect(first.document).toMatchObject({
      projectId: first.project.id,
      organizationId: ACME,
      name: 'Welcome',
      value1: 'Hello',
      value2: 'World',
      updatedBy: alice.sub,
    });
    expect(first.document.zedtoken).not.toBe('');

    const second = await service.ensurePersonalProject(alice, ACME);
    expect(second.created).toBe(false);
    expect(second.project.id).toBe(first.project.id);
    expect(second.document.id).toBe(first.document.id);

    const personal = await database.db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, ACME));
    expect(personal).toHaveLength(1);
  });

  it('leaves exactly one project under concurrent calls', async () => {
    const organization = randomUUID();
    await authz.writeRelationships([
      touch(relationship(ref('organization', organization), 'admin', ref('user', carol.sub))),
    ]);
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => service.ensurePersonalProject(carol, organization)),
    );
    expect(new Set(outcomes.map((outcome) => outcome.project.id)).size).toBe(1);
    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    await authz.deleteRelationships({ resourceType: 'organization', resourceId: organization });
  });

  it('is not available to someone who cannot create projects there', async () => {
    await expect(service.ensurePersonalProject(carol, ACME)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('listVisibleDocuments, getDocumentForEdit, updateDocument', () => {
  it('follows the three states of the dashboard', async () => {
    const { project, document } = await service.ensurePersonalProject(alice, ACME);
    // A grant stores its token on the row, as the share action will (§7.3, ticket 21), so that reads at least as
    // fresh as the row see it; written directly here, the grant would otherwise be invisible for one window.
    const granted = await authz.writeRelationships([
      touch(relationship(ref('project', project.id), 'viewer', ref('user', bob.sub))),
    ]);
    await database.db
      .update(documents)
      .set({ zedtoken: granted })
      .where(eq(documents.id, document.id));

    const forAlice = await service.listVisibleDocuments(alice, fullyConsistent);
    expect(forAlice).toEqual([
      {
        id: document.id,
        name: 'Welcome',
        project: { id: project.id, name: 'Personal' },
        organization: { id: ACME, name: 'Acme' },
        canEdit: true,
        updatedAt: document.updatedAt,
      },
    ]);
    const forBob = await service.listVisibleDocuments(bob, fullyConsistent);
    expect(forBob.map((row) => [row.id, row.canEdit])).toEqual([[document.id, false]]);
    expect(await service.listVisibleDocuments(carol, fullyConsistent)).toEqual([]);

    expect((await service.getDocumentForEdit(alice, document.id)).id).toBe(document.id);
    await expect(service.getDocumentForEdit(bob, document.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(service.getDocumentForEdit(carol, document.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(service.getDocumentForEdit(alice, randomUUID())).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('stores the values with the token of the fully consistent check', async () => {
    const { document } = await service.ensurePersonalProject(alice, ACME);
    const values = { value1: 'Goodbye', value2: 'Moon' };

    const updated = await service.updateDocument(alice, document.id, values);
    expect(updated).toMatchObject({ ...values, updatedBy: alice.sub });
    expect(updated.zedtoken).not.toBe(document.zedtoken);
    expect(updated.updatedAt.getTime()).toBeGreaterThan(document.updatedAt.getTime());
    expect(await service.getDocumentForEdit(alice, document.id)).toEqual(updated);

    await expect(service.updateDocument(bob, document.id, values)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(service.updateDocument(carol, document.id, values)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      service.updateDocument(alice, document.id, { value1: '', value2: 'x' }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(service.updateDocument(alice, randomUUID(), values)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
