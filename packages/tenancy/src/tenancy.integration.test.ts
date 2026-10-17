/**
 * Against the compose stack (`docker compose up -d --wait`; CI's integration job): a database of its own,
 * `it_tenancy`, migrated from zero on the stack's Postgres, and the compose SpiceDB with subjects unique to
 * this run. Connection defaults come from the committed root .env, as in packages/authz.
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

import { createInProcessTenancyClient } from './in-process-client';
import { organizations, schema, users, type TenancySchema } from './schema';

import { createTenancyService, TenancyError, type TenancyService } from './index';

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
const sub = (name: string) => `it-${RUN}-${name}`;
const claims = (name: string) => ({ sub: sub(name), email: `${name}@example.com`, name });

let authz: Authz;
let database: TestDatabase<TenancySchema>;
let service: TenancyService;
const organizationIds = new Set<string>();

beforeAll(async () => {
  loadStackDefaults();
  authz = createAuthz(authzOptionsFromEnv());
  await ensureSchema(authz);
  database = await createTestDatabase({
    adminUrl: adminUrlFromEnv(),
    name: 'it_tenancy',
    schema,
    migrationsFolder: new URL('../migrations', import.meta.url).pathname,
  });
  service = createTenancyService({ db: database.db, authz });
});

afterAll(async () => {
  for (const id of organizationIds) {
    await authz.deleteRelationships({ resourceType: 'organization', resourceId: id });
  }
  await database.drop();
  authz.close();
});

/** A shared organization with one admin, written the way bootstrap's seeds will (ticket 12). */
async function sharedOrganization(name: string, adminSub: string): Promise<string> {
  const [row] = await database.db.insert(organizations).values({ name }).returning();
  if (!row) throw new Error('insert returned no row');
  organizationIds.add(row.id);
  await authz.writeRelationships([
    touch(relationship(ref('organization', row.id), 'admin', ref('user', adminSub))),
  ]);
  return row.id;
}

describe('migrations', () => {
  it('created the tables and recorded the migration', async () => {
    const tables = await database.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(tables.map((row) => row.table_name)).toEqual(['organizations', 'users']);
    const applied = await database.db.execute<{ count: string }>(
      sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
    );
    expect(applied[0]?.count).toBe('1');
  });
});

describe('provisionUser', () => {
  it('creates the mirror row and the personal organization once', async () => {
    const first = await service.provisionUser(claims('alice'));
    organizationIds.add(first.organization.id);
    expect(first.created).toBe(true);
    expect(first.user).toMatchObject({
      id: sub('alice'),
      email: 'alice@example.com',
      displayName: 'alice',
    });
    expect(first.organization).toMatchObject({
      isPersonal: true,
      ownerId: sub('alice'),
      policy: {},
    });

    const second = await service.provisionUser(claims('alice'));
    expect(second.created).toBe(false);
    expect(second.organization.id).toBe(first.organization.id);
    expect(second.user.createdAt).toEqual(first.user.createdAt);

    const owned = await database.db
      .select()
      .from(organizations)
      .where(eq(organizations.ownerId, sub('alice')));
    expect(owned).toHaveLength(1);
  });

  it('leaves exactly one of each under concurrent first calls', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => service.provisionUser(claims('dave'))),
    );
    const ids = new Set(outcomes.map((outcome) => outcome.organization.id));
    expect(ids.size).toBe(1);
    for (const id of ids) organizationIds.add(id);
    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(users)
        .where(eq(users.id, sub('dave'))),
    ).toHaveLength(1);
  });

  it('makes the owner the administrator', async () => {
    const { organization } = await service.provisionUser(claims('alice'));
    const check = await authz.check({
      resource: ref('organization', organization.id),
      permission: 'administer',
      subject: ref('user', sub('alice')),
      consistency: fullyConsistent,
    });
    expect(check.allowed).toBe(true);
  });
});

describe('getOrganization and listOrganizations', () => {
  it('shows an organization to those who may view it and to nobody else', async () => {
    const { organization } = await service.provisionUser(claims('alice'));
    const own = await service.getOrganization(
      { sub: sub('alice') },
      organization.id,
      fullyConsistent,
    );
    expect(own?.id).toBe(organization.id);
    const stranger = await service.getOrganization(
      { sub: sub('eve') },
      organization.id,
      fullyConsistent,
    );
    expect(stranger).toBeUndefined();
    const unknown = await service.getOrganization(
      { sub: sub('alice') },
      randomUUID(),
      fullyConsistent,
    );
    expect(unknown).toBeUndefined();
  });

  it('lists every visible organization by name', async () => {
    const { organization: personal } = await service.provisionUser(claims('alice'));
    const acme = await sharedOrganization('Acme', sub('alice'));
    const listed = await service.listOrganizations({ sub: sub('alice') }, fullyConsistent);
    expect(listed.map((row) => row.id)).toEqual([acme, personal.id]);
    expect(await service.listOrganizations({ sub: sub('eve') }, fullyConsistent)).toEqual([]);
  });
});

describe('setMembership', () => {
  it('refuses on a personal organization', async () => {
    const { organization } = await service.provisionUser(claims('alice'));
    await expect(
      service.setMembership({ sub: sub('alice') }, organization.id, sub('bob'), 'member'),
    ).rejects.toMatchObject({ code: 'personal_organization' });
  });

  it('grants, switches, and removes a role, administrators only', async () => {
    const acme = await sharedOrganization('Acme', sub('alice'));
    const alice = { sub: sub('alice') };
    const bob = { sub: sub('bob') };

    await expect(service.setMembership(bob, acme, sub('carol'), 'member')).rejects.toMatchObject({
      code: 'not_found',
    });
    await service.setMembership(alice, acme, sub('bob'), 'member');
    expect((await service.getOrganization(bob, acme, fullyConsistent))?.id).toBe(acme);
    await expect(service.setMembership(bob, acme, sub('carol'), 'member')).rejects.toMatchObject({
      code: 'forbidden',
    });

    await service.setMembership(alice, acme, sub('bob'), 'admin');
    await service.setMembership(bob, acme, sub('carol'), 'member');
    expect((await service.getOrganization({ sub: sub('carol') }, acme, fullyConsistent))?.id).toBe(
      acme,
    );

    await service.setMembership(alice, acme, sub('bob'), null);
    expect(await service.getOrganization(bob, acme, fullyConsistent)).toBeUndefined();
    await expect(
      service.setMembership(alice, randomUUID(), sub('bob'), 'member'),
    ).rejects.toBeInstanceOf(TenancyError);
  });
});

describe('setPolicy', () => {
  it('validates and stores the policy for administrators', async () => {
    const acme = await sharedOrganization('Acme', sub('alice'));
    const alice = { sub: sub('alice') };
    await service.setMembership(alice, acme, sub('bob'), 'member');

    const updated = await service.setPolicy(alice, acme, { max_auth_age_seconds: 600 });
    expect(updated.policy).toEqual({ max_auth_age_seconds: 600 });
    await expect(
      service.setPolicy(alice, acme, { max_auth_age_seconds: -1 }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(service.setPolicy(alice, acme, { unknown: true })).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(service.setPolicy({ sub: sub('bob') }, acme, {})).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await service.getOrganization(alice, acme, fullyConsistent))?.policy).toEqual({
      max_auth_age_seconds: 600,
    });
  });
});

describe('in-process TenancyClient', () => {
  it('maps the service to the client contract', async () => {
    const client = createInProcessTenancyClient(service, (user) =>
      Promise.resolve({ sub: user.sub, email: `${user.sub}@example.com`, name: user.sub }),
    );
    const user = { sub: sub('frank'), accessToken: 'unused' };
    const provisioned = await client.provisionUser(user);
    organizationIds.add(provisioned.organization.id);
    expect(provisioned.created).toBe(true);
    expect(provisioned.organization).toEqual({
      id: provisioned.organization.id,
      name: 'Personal',
      isPersonal: true,
      policy: {},
    });
    expect(await client.getOrganization(user, provisioned.organization.id)).toEqual(
      provisioned.organization,
    );
    expect(await client.listOrganizations(user)).toEqual([provisioned.organization]);
    expect(
      await client.getOrganization(
        { sub: sub('eve'), accessToken: 'unused' },
        provisioned.organization.id,
      ),
    ).toBeUndefined();
  });
});
