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
import { describeTenancyClientContract } from './testing/contract';

import {
  createTenancyService,
  seedOrganization,
  TenancyError,
  type Role,
  type TenancyService,
} from './index';

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

/**
 * A shared organization with these roles, written the way bootstrap's seeds are (ticket 12): the only way a
 * first role is granted, since `setMembership` changes current members only (§6.8).
 */
async function sharedOrganization(
  name: string,
  members: { sub: string; displayName?: string; role: Role }[],
): Promise<string> {
  const id = randomUUID();
  organizationIds.add(id);
  await seedOrganization(
    { db: database.db, authz },
    {
      id,
      name,
      users: members
        .filter((member) => member.displayName !== undefined)
        .map((member) => ({
          sub: member.sub,
          email: `${member.sub}@example.com`,
          displayName: member.displayName ?? '',
        })),
      roles: members.map(({ sub, role }) => ({ sub, role })),
    },
  );
  return id;
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
    expect(await service.getUser(sub('alice'))).toBeUndefined();
    const first = await service.provisionUser(claims('alice'));
    organizationIds.add(first.organization.id);
    expect(first.created).toBe(true);
    expect(await service.getUser(sub('alice'))).toEqual(first.user);
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
    const acme = await sharedOrganization('Acme', [{ sub: sub('alice'), role: 'admin' }]);
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

  it('switches and removes a current member, administrators only, never the last one', async () => {
    const acme = await sharedOrganization('Acme', [
      { sub: sub('alice'), role: 'admin' },
      { sub: sub('bob'), role: 'member' },
      { sub: sub('carol'), role: 'member' },
    ]);
    const alice = { sub: sub('alice') };
    const bob = { sub: sub('bob') };
    const carol = { sub: sub('carol') };

    // Who may: an administrator. A member is refused, a stranger learns nothing.
    await expect(service.setMembership(bob, acme, sub('carol'), 'admin')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      service.setMembership({ sub: sub('eve') }, acme, sub('carol'), 'admin'),
    ).rejects.toMatchObject({ code: 'not_found' });

    // Promote, and the new administrator may change roles too; demote, and may not.
    await service.setMembership(alice, acme, sub('bob'), 'admin');
    await service.setMembership(bob, acme, sub('carol'), 'admin');
    await service.setMembership(alice, acme, sub('carol'), 'member');
    await expect(service.setMembership(carol, acme, sub('bob'), 'member')).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(
      (await service.listMembers(alice, acme, fullyConsistent))?.map((m) => [m.sub, m.role]),
    ).toEqual([
      [sub('alice'), 'admin'],
      [sub('bob'), 'admin'],
      [sub('carol'), 'member'],
    ]);

    // Remove: the former member sees nothing and cannot be granted a role from here again (§6.8).
    await service.setMembership(alice, acme, sub('bob'), null);
    expect(await service.getOrganization(bob, acme, fullyConsistent)).toBeUndefined();
    await expect(service.setMembership(alice, acme, sub('bob'), 'member')).rejects.toMatchObject({
      code: 'not_a_member',
    });

    // The last administrator can be neither demoted nor removed.
    await expect(service.setMembership(alice, acme, sub('alice'), 'member')).rejects.toMatchObject({
      code: 'last_admin',
    });
    await expect(service.setMembership(alice, acme, sub('alice'), null)).rejects.toMatchObject({
      code: 'last_admin',
    });
    await expect(
      service.setMembership(alice, randomUUID(), sub('carol'), 'member'),
    ).rejects.toBeInstanceOf(TenancyError);
  });
});

describe('listMembers', () => {
  it('joins the roles in SpiceDB to the users mirror, admins first, for members only', async () => {
    // Subs of their own: a mirror row that exists (an earlier login) keeps what it has, by design (§6.3).
    const acme = await sharedOrganization('Acme', [
      { sub: sub('list-zed'), displayName: 'Zed Member', role: 'member' },
      { sub: sub('list-alice'), displayName: 'Alice Adams', role: 'admin' },
      // A role with no mirror row (a sub that changed with a reset IdP, §6.3) is still a member.
      { sub: sub('list-ghost'), role: 'member' },
    ]);
    const members = await service.listMembers({ sub: sub('list-zed') }, acme, fullyConsistent);
    expect(members).toEqual([
      {
        sub: sub('list-alice'),
        email: `${sub('list-alice')}@example.com`,
        displayName: 'Alice Adams',
        role: 'admin',
      },
      { sub: sub('list-ghost'), role: 'member' },
      {
        sub: sub('list-zed'),
        email: `${sub('list-zed')}@example.com`,
        displayName: 'Zed Member',
        role: 'member',
      },
    ]);
    expect(await service.listMembers({ sub: sub('eve') }, acme, fullyConsistent)).toBeUndefined();
    expect(
      await service.listMembers({ sub: sub('list-alice') }, randomUUID(), fullyConsistent),
    ).toBeUndefined();
  });
});

describe('setPolicy', () => {
  it('validates and stores the policy for administrators', async () => {
    const acme = await sharedOrganization('Acme', [
      { sub: sub('alice'), role: 'admin' },
      { sub: sub('bob'), role: 'member' },
    ]);
    const alice = { sub: sub('alice') };

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

describe('seedOrganization', () => {
  it('creates the mirror rows, the organization, and its roles once, and repairs the roles on every run', async () => {
    const id = randomUUID();
    organizationIds.add(id);
    const seed = {
      id,
      name: 'Seeded',
      users: [
        { sub: sub('seed-alice'), email: 'seed-alice@example.com', displayName: 'Alice Adams' },
        { sub: sub('seed-bob'), email: 'seed-bob@example.com', displayName: 'Bob Baker' },
      ],
      roles: [
        { sub: sub('seed-alice'), role: 'admin' as const },
        { sub: sub('seed-bob'), role: 'member' as const },
      ],
    };
    const first = await seedOrganization({ db: database.db, authz }, seed);
    expect(first.created).toBe(true);
    expect(first.createdUsers).toEqual([sub('seed-alice'), sub('seed-bob')]);
    expect(first.organization).toMatchObject({
      id,
      name: 'Seeded',
      isPersonal: false,
      ownerId: null,
      policy: {},
    });
    expect(first.token).not.toBe('');
    expect(await service.getUser(sub('seed-bob'))).toMatchObject({
      email: 'seed-bob@example.com',
      displayName: 'Bob Baker',
    });

    const alice = { sub: sub('seed-alice') };
    const bob = { sub: sub('seed-bob') };
    expect((await service.getOrganization(alice, id, fullyConsistent))?.id).toBe(id);
    expect((await service.getOrganization(bob, id, fullyConsistent))?.id).toBe(id);
    expect(await service.getOrganization({ sub: sub('eve') }, id, fullyConsistent)).toBeUndefined();
    await expect(service.setMembership(bob, id, sub('eve'), 'member')).rejects.toMatchObject({
      code: 'forbidden',
    });

    // A rerun creates nothing and rewrites nothing a user or an admin changed, but puts the roles back.
    await service.setPolicy(alice, id, { max_auth_age_seconds: 600 });
    await service.setMembership(alice, id, sub('seed-bob'), null);
    expect(await service.getOrganization(bob, id, fullyConsistent)).toBeUndefined();
    const second = await seedOrganization(
      { db: database.db, authz },
      { ...seed, name: 'Renamed', users: [{ ...seed.users[1]!, displayName: 'Robert' }] },
    );
    expect(second.created).toBe(false);
    expect(second.createdUsers).toEqual([]);
    expect(second.organization).toEqual({
      ...first.organization,
      policy: { max_auth_age_seconds: 600 },
    });
    expect(second.token).not.toBe(first.token);
    expect((await service.getUser(sub('seed-bob')))?.displayName).toBe('Bob Baker');
    expect((await service.getOrganization(bob, id, fullyConsistent))?.id).toBe(id);
  });

  it('refuses an ID SpiceDB would not accept before writing anything', async () => {
    const id = randomUUID();
    await expect(
      seedOrganization(
        { db: database.db, authz },
        { id, name: 'Broken', users: [], roles: [{ sub: 'has:colon', role: 'admin' }] },
      ),
    ).rejects.toThrow(/invalid SpiceDB object ID/);
    expect(
      await database.db.select().from(organizations).where(eq(organizations.id, id)),
    ).toHaveLength(0);
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

describeTenancyClientContract('in-process', () => ({
  client: createInProcessTenancyClient(service, (user) =>
    Promise.resolve({ sub: user.sub, email: `${user.sub}@example.com`, name: user.sub }),
  ),
  user: (name) => Promise.resolve({ sub: sub(`contract-${name}`), accessToken: 'unused' }),
  sharedOrganization,
  track: (id) => organizationIds.add(id),
}));
