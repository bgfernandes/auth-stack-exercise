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
  atLeastAsFresh,
  authzOptionsFromEnv,
  createAuthz,
  fullyConsistent,
  minimizeLatency,
  ref,
  relationship,
  remove,
  touch,
  type Authz,
  type Consistency,
} from '@auth-stack/authz';
import { ensureSchema } from '@auth-stack/authz/schema';
import {
  adminUrlFromEnv,
  createTestDatabase,
  type TestDatabase,
} from '@auth-stack/db-core/testing';
import { type OrganizationSummary, type TenancyClient } from '@auth-stack/tenancy/client';

import { documents, projects, schema, type DocumentsSchema } from './schema';

import { createDocumentsService, seedDocuments, type DocumentsService } from './index';

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
/** The organization of the seeded scenario (§6.3), with users of its own so the lists above stay exact. */
const SEEDED = randomUUID();

const fakeTenancy: Pick<TenancyClient, 'getOrganization'> = {
  getOrganization: (_user, id) => {
    const known: Record<string, OrganizationSummary> = {
      [ACME]: { id: ACME, name: 'Acme', isPersonal: false, policy: {} },
      [SEEDED]: { id: SEEDED, name: 'Seeded', isPersonal: false, policy: {} },
    };
    return Promise.resolve(known[id]);
  },
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
  for (const { id } of await database.db.select({ id: documents.id }).from(documents)) {
    await authz.deleteRelationships({ resourceType: 'document', resourceId: id });
  }
  for (const { id } of await database.db.select({ id: projects.id }).from(projects)) {
    await authz.deleteRelationships({ resourceType: 'project', resourceId: id });
  }
  for (const id of [ACME, SEEDED]) {
    await authz.deleteRelationships({ resourceType: 'organization', resourceId: id });
  }
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
        canShare: true,
        updatedAt: document.updatedAt,
      },
    ]);
    const forBob = await service.listVisibleDocuments(bob, fullyConsistent);
    expect(forBob.map((row) => [row.id, row.canEdit, row.canShare])).toEqual([
      [document.id, false, false],
    ]);
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
    await expect(service.getDocumentForEdit(alice, 'not-a-uuid')).rejects.toMatchObject({
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
    await expect(service.updateDocument(alice, 'not-a-uuid', values)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('setDocumentShares', () => {
  // Dave is a second Acme member (Bob is the first); Carol stays the outsider she is above. The documents are
  // seeded ones of a project nobody but Alice, as the admin, can reach: one per test, so no share carries over.
  const dave = user('dave');
  const project = randomUUID();
  const docs = [randomUUID(), randomUUID(), randomUUID()] as const;
  beforeAll(async () => {
    await authz.writeRelationships([
      touch(relationship(ref('organization', ACME), 'member', ref('user', dave.sub))),
    ]);
    await seedDocuments(
      { db: database.db, authz },
      {
        organizationId: ACME,
        createdBy: alice.sub,
        projects: [{ id: project, name: 'Shares' }],
        documents: docs.map((id, index) => ({
          id,
          projectId: project,
          name: `Shared ${index}`,
          value1: 'a',
          value2: 'b',
        })),
      },
    );
  });
  const documentOf = async (index: 0 | 1 | 2) => service.getDocumentForEdit(alice, docs[index]);

  const sharesOf = async (id: string) => {
    const found = await authz.readRelationships(
      { resourceType: 'document', resourceId: id },
      fullyConsistent,
    );
    return found
      .filter(({ subject }) => subject.type === 'user')
      .map(({ relation, subject }) => `${relation}:${subject.id}`)
      .sort();
  };

  it('replaces the direct shares atomically and stores the write token on the row', async () => {
    const document = await documentOf(0);
    expect(await service.listVisibleDocuments(dave, fullyConsistent)).toEqual([]);

    // Bob may view and Dave may edit, both Acme members; the token moves forward with the write.
    const shared = await service.setDocumentShares(alice, document.id, {
      editors: [dave.sub],
      viewers: [bob.sub],
    });
    expect(shared.zedtoken).not.toBe('');
    expect(shared).toMatchObject({
      value1: document.value1,
      value2: document.value2,
      updatedBy: document.updatedBy,
    });
    expect(await sharesOf(document.id)).toEqual([`editor:${dave.sub}`, `viewer:${bob.sub}`].sort());
    // The share page's read sees the set the share left, at the row's token; it is for sharers only.
    expect(await service.getDocumentShares(alice, document.id)).toEqual({
      editors: [dave.sub],
      viewers: [bob.sub],
    });
    await expect(service.getDocumentShares(dave, document.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(service.getDocumentShares(carol, document.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await service.getDocumentForEdit(dave, document.id)).id).toBe(document.id);
    await expect(service.getDocumentForEdit(bob, document.id)).rejects.toMatchObject({
      code: 'forbidden',
    });

    // The replacement removes what is not listed any more and keeps what is: Bob loses, Dave stays.
    const replaced = await service.setDocumentShares(alice, document.id, {
      editors: [dave.sub],
      viewers: [],
    });
    expect(await sharesOf(document.id)).toEqual([`editor:${dave.sub}`]);
    await expect(service.getDocumentForEdit(bob, document.id)).rejects.toMatchObject({
      code: 'not_found',
    });

    // An unchanged set writes nothing and keeps a valid token on the row.
    const unchanged = await service.setDocumentShares(alice, document.id, {
      editors: [dave.sub],
      viewers: [],
    });
    expect(unchanged.zedtoken).not.toBe('');
    expect(await sharesOf(document.id)).toEqual([`editor:${dave.sub}`]);
    expect(replaced.zedtoken).not.toBe(shared.zedtoken);

    const cleared = await service.setDocumentShares(alice, document.id, {
      editors: [],
      viewers: [],
    });
    expect(await sharesOf(document.id)).toEqual([]);
    expect(cleared.zedtoken).not.toBe(replaced.zedtoken);
    await expect(service.getDocumentForEdit(dave, document.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('is for whoever may share: an editor by share gets 403, a stranger 404, and so does a bad id', async () => {
    const document = await documentOf(1);
    await service.setDocumentShares(alice, document.id, { editors: [dave.sub], viewers: [] });
    const shares = { editors: [], viewers: [bob.sub] };
    await expect(service.setDocumentShares(dave, document.id, shares)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(service.setDocumentShares(carol, document.id, shares)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(service.setDocumentShares(alice, randomUUID(), shares)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(service.setDocumentShares(alice, 'not-a-uuid', shares)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await sharesOf(document.id)).toEqual([`editor:${dave.sub}`]);
  });

  it('refuses a user outside the organization, and a malformed set, before writing anything', async () => {
    const document = await documentOf(2);
    await expect(
      service.setDocumentShares(alice, document.id, { editors: [bob.sub, carol.sub], viewers: [] }),
    ).rejects.toMatchObject({ code: 'not_a_member' });
    await expect(
      service.setDocumentShares(alice, document.id, { editors: [bob.sub], viewers: [bob.sub] }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(await sharesOf(document.id)).toEqual([]);
  });
});

describe('the New Enemy problem (§7)', () => {
  // The window inside which a `minimize_latency` answer is the snapshot before a write: compose pins SpiceDB's
  // `--datastore-revision-quantization-interval` at 5 s, and SpiceDB may keep serving a window's revision for a
  // tenth of that after it ends (`--datastore-revision-quantization-max-staleness-percent`, 0.1 by default).
  // What a listing may lag is that plus cache propagation; the tests allow seven seconds.
  const WINDOW_MS = 5_000;
  const LAG_MS = 7_000;
  const erin = user('erin');

  beforeAll(async () => {
    await authz.writeRelationships([
      touch(relationship(ref('organization', ACME), 'member', ref('user', erin.sub))),
    ]);
  });

  /**
   * A project of its own with Bob as an editor and one document, Bob's role written before the seed so that the
   * token the seed stores on the row postdates the grant: Bob's reads at the row's token see it at once (§7.3).
   */
  async function fixture() {
    const project = randomUUID();
    const id = randomUUID();
    await authz.writeRelationships([
      touch(relationship(ref('project', project), 'editor', ref('user', bob.sub))),
    ]);
    await seedDocuments(
      { db: database.db, authz },
      {
        organizationId: ACME,
        createdBy: alice.sub,
        projects: [{ id: project, name: `Enemy ${project.slice(0, 8)}` }],
        documents: [{ id, projectId: project, name: 'Secret', value1: 'a', value2: 'b' }],
      },
    );
    return { project, document: await service.getDocumentForEdit(bob, id) };
  }

  const canView = async (sub: string, id: string, consistency: Consistency) =>
    (
      await authz.check({
        resource: ref('document', id),
        permission: 'view',
        subject: ref('user', sub),
        consistency,
      })
    ).allowed;
  const lists = async (sub: string, id: string, consistency: Consistency) =>
    (await service.listVisibleDocuments({ sub, accessToken: 'unused' }, consistency)).some(
      (row) => row.id === id,
    );

  /** Polls `read` until it returns `expected`, inside the lag; the time it took, or a failure with the last value. */
  async function within(
    ms: number,
    read: () => Promise<boolean>,
    expected: boolean,
  ): Promise<number> {
    const started = Date.now();
    let last = await read();
    while (last !== expected && Date.now() - started < ms) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      last = await read();
    }
    expect(last).toBe(expected);
    return Date.now() - started;
  }

  /**
   * Puts a test inside a quantization window whose snapshot predates the removal it is about to make, going by
   * what SpiceDB serves rather than by the clock. SpiceDB pins a window's snapshot to the first transaction at
   * or after the window's start, and serves the head until one lands (observed on the Postgres datastore: a
   * write that is the first of its window is visible at `minimize_latency` at once). So: wait until the
   * fixture is visible at that level, then make one more write, the anchor, so that whichever transaction the
   * window pins to, the anchor or an earlier one, holds the fixture and precedes what the test writes next;
   * and keep away from the boundary by the clock as well, so the test's own writes stay inside the window.
   */
  async function inStaleWindow() {
    const { project, document } = await fixture();
    await within(LAG_MS, () => canView(bob.sub, document.id, minimizeLatency), true);
    const phase = Date.now() % WINDOW_MS;
    if (phase < 500 || phase > WINDOW_MS - 1_500) {
      await new Promise((resolve) => setTimeout(resolve, WINDOW_MS - phase + 500));
    }
    await authz.writeRelationships([
      touch(relationship(ref('organization', ACME), 'member', ref('user', erin.sub))),
    ]);
    expect(await canView(bob.sub, document.id, minimizeLatency)).toBe(true);
    return { project, document, start: Date.now() };
  }

  /**
   * The removal that opens the window: Bob loses his project role, the write tenancy's membership change makes
   * (tenancy is faked here). The stale snapshot still holds it until the window ends.
   */
  const removeBob = (project: string) =>
    authz.writeRelationships([
      remove(relationship(ref('project', project), 'editor', ref('user', bob.sub))),
    ]);

  /**
   * What both cases assert once the row carries a token that postdates the removal: the old snapshot still
   * allows and still lists (the New Enemy, inside the window), while a read at the row's token, and at the
   * head, refuses, and the listing converges inside the lag.
   */
  async function assertEnemyThenToken(document: { id: string; zedtoken: string }, start: number) {
    const stale = await canView(bob.sub, document.id, minimizeLatency);
    const listed = await lists(bob.sub, document.id, minimizeLatency);
    const elapsed = Date.now() - start;
    // The window is the premise: a run that may have outlived it proves nothing either way, so say so.
    if (elapsed > 1_000) throw new Error(`the run took ${elapsed} ms, too long for one window`);
    expect(stale).toBe(true);
    expect(listed).toBe(true);

    expect(await canView(bob.sub, document.id, atLeastAsFresh(document.zedtoken))).toBe(false);
    expect(await canView(bob.sub, document.id, fullyConsistent)).toBe(false);
    await expect(service.getDocumentForEdit(bob, document.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await lists(bob.sub, document.id, fullyConsistent)).toBe(false);

    // Convergence: the listing and the check each inside the lag, polled apart, since SpiceDB may serve either
    // call the old revision for a while after the window ends (the max-staleness allowance is taken per call).
    const since = Date.now();
    await within(LAG_MS, () => lists(bob.sub, document.id, minimizeLatency), false);
    await within(LAG_MS, () => canView(bob.sub, document.id, minimizeLatency), false);
    expect(Date.now() - since).toBeLessThan(LAG_MS);
  }

  it('case 2, an old ACL applied to new content: removed, then edited, Bob reads nothing at the row token', async () => {
    const { project, document, start } = await inStaleWindow();
    await removeBob(project);
    const edited = await service.updateDocument(alice, document.id, {
      value1: 'after',
      value2: 'removal',
    });
    expect(edited.zedtoken).not.toBe(document.zedtoken);
    await assertEnemyThenToken(edited, start);
  }, 30_000);

  it('case 1, update order neglected: removed, then shared to Erin, Bob reads nothing and Erin reads at once', async () => {
    const { project, document, start } = await inStaleWindow();
    await removeBob(project);
    const shared = await service.setDocumentShares(alice, document.id, {
      editors: [erin.sub],
      viewers: [],
    });
    expect(shared.zedtoken).not.toBe(document.zedtoken);
    // The grant is no false negative either: the row's token postdates it (§7.3's share row).
    expect((await service.getDocumentForEdit(erin, document.id)).id).toBe(document.id);
    await assertEnemyThenToken(shared, start);
  }, 30_000);
});

describe('seedDocuments', () => {
  // The §6.3 scenario under IDs of this run: Alice administers, Bob and Carol are members (tenancy's part).
  const seedAlice = user('seed-alice');
  const seedBob = user('seed-bob');
  const seedCarol = user('seed-carol');
  const marketing = randomUUID();
  const finance = randomUUID();
  const launchPlan = randomUUID();
  const budget = randomUUID();
  const payroll = randomUUID();
  const scenario = {
    organizationId: SEEDED,
    createdBy: seedAlice.sub,
    projects: [
      {
        id: marketing,
        name: 'Marketing',
        roles: [
          { sub: seedBob.sub, role: 'editor' as const },
          { sub: seedCarol.sub, role: 'viewer' as const },
        ],
      },
      { id: finance, name: 'Finance' },
    ],
    documents: [
      {
        id: launchPlan,
        projectId: marketing,
        name: 'Launch plan',
        value1: 'a',
        value2: 'b',
        roles: [{ sub: seedCarol.sub, role: 'editor' as const }],
      },
      { id: budget, projectId: marketing, name: 'Budget', value1: 'c', value2: 'd' },
      { id: payroll, projectId: finance, name: 'Payroll', value1: 'e', value2: 'f' },
    ],
  };

  beforeAll(async () => {
    await authz.writeRelationships([
      touch(relationship(ref('organization', SEEDED), 'admin', ref('user', seedAlice.sub))),
      touch(relationship(ref('organization', SEEDED), 'member', ref('user', seedBob.sub))),
      touch(relationship(ref('organization', SEEDED), 'member', ref('user', seedCarol.sub))),
    ]);
  });

  it('creates the projects and documents once, with the write token on every document', async () => {
    const first = await seedDocuments({ db: database.db, authz }, scenario);
    expect(first.createdProjects.sort()).toEqual([marketing, finance].sort());
    expect(first.createdDocuments.sort()).toEqual([launchPlan, budget, payroll].sort());
    expect(first.token).not.toBe('');
    const rows = await database.db
      .select()
      .from(documents)
      .where(eq(documents.organizationId, SEEDED));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({ zedtoken: first.token, updatedBy: seedAlice.sub });
    }

    // A rerun creates nothing, keeps an edit a user made, and moves every document's token forward.
    const edited = await service.updateDocument(seedAlice, budget, { value1: 'x', value2: 'y' });
    const second = await seedDocuments({ db: database.db, authz }, scenario);
    expect(second.createdProjects).toEqual([]);
    expect(second.createdDocuments).toEqual([]);
    expect(second.token).not.toBe(first.token);
    const [budgetRow] = await database.db.select().from(documents).where(eq(documents.id, budget));
    expect(budgetRow).toEqual({ ...edited, zedtoken: second.token });
    expect(
      await database.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.organizationId, SEEDED)),
    ).toHaveLength(2);
  });

  it('gives the three users the dashboards of §6.3', async () => {
    const table = async (who: typeof seedAlice) =>
      (await service.listVisibleDocuments(who, fullyConsistent)).map((row) => [
        row.project.name,
        row.name,
        row.canEdit,
      ]);
    expect(await table(seedAlice)).toEqual([
      ['Finance', 'Payroll', true],
      ['Marketing', 'Budget', true],
      ['Marketing', 'Launch plan', true],
    ]);
    expect(await table(seedBob)).toEqual([
      ['Marketing', 'Budget', true],
      ['Marketing', 'Launch plan', true],
    ]);
    expect(await table(seedCarol)).toEqual([
      ['Marketing', 'Budget', false],
      ['Marketing', 'Launch plan', true],
    ]);
    expect(
      (await service.listVisibleDocuments(seedAlice, fullyConsistent))[0]?.organization,
    ).toEqual({
      id: SEEDED,
      name: 'Seeded',
    });

    for (const id of [launchPlan, budget, payroll]) {
      expect((await service.getDocumentForEdit(seedAlice, id)).id).toBe(id);
    }
    expect((await service.getDocumentForEdit(seedCarol, launchPlan)).id).toBe(launchPlan);
    await expect(service.getDocumentForEdit(seedCarol, budget)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(service.getDocumentForEdit(seedCarol, payroll)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(service.getDocumentForEdit(seedBob, payroll)).rejects.toMatchObject({
      code: 'not_found',
    });
    const values = { value1: 'p', value2: 'q' };
    await expect(service.updateDocument(seedCarol, budget, values)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(service.updateDocument(seedCarol, payroll, values)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('repairs a share removed by hand on the next run, visibly to the edit page', async () => {
    await authz.deleteRelationships({
      resourceType: 'document',
      resourceId: launchPlan,
      relation: 'editor',
      subject: { type: 'user', id: seedCarol.sub },
    });
    await expect(
      service.updateDocument(seedCarol, launchPlan, { value1: 'p', value2: 'q' }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    await seedDocuments({ db: database.db, authz }, scenario);
    expect((await service.getDocumentForEdit(seedCarol, launchPlan)).id).toBe(launchPlan);
  });

  it('refuses a document whose project the seed does not name, before writing anything', async () => {
    const id = randomUUID();
    await expect(
      seedDocuments(
        { db: database.db, authz },
        {
          organizationId: SEEDED,
          createdBy: seedAlice.sub,
          projects: [],
          documents: [{ id, projectId: randomUUID(), name: 'Orphan', value1: 'a', value2: 'b' }],
        },
      ),
    ).rejects.toThrow(/names a project the seed does not/);
    expect(await database.db.select().from(documents).where(eq(documents.id, id))).toHaveLength(0);
  });
});
