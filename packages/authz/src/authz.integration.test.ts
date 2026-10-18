/**
 * Against the compose SpiceDB (`docker compose up -d --wait`; CI's integration job). Reads the connection from
 * the environment and falls back to the committed development defaults in the root .env, which are the
 * stack's own, so nothing is duplicated here. Relationships use the `it-` prefix and are removed before and
 * after, so the seeded data of ticket 12 and these tests never see each other.
 */
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { ensureSchema } from './schema';

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
  VOCABULARY,
  type Authz,
  type ObjectType,
  type ZedToken,
} from './index';

// Not process.loadEnvFile: Jest gives each test file its own copy of `process.env`, and loadEnvFile writes to the real one.
function loadStackDefaults(): void {
  const defaults = parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8'));
  process.env.SPICEDB_PRESHARED_KEY ??= defaults.SPICEDB_PRESHARED_KEY;
  process.env.SPICEDB_INSECURE ??= defaults.SPICEDB_INSECURE;
  process.env.SPICEDB_ENDPOINT ??= 'localhost:50051';
}

const PREFIX = 'it-';
const id = (name: string) => `${PREFIX}${name}`;

// The §6.3 scenario, with the labels of docs/README.md as IDs.
const acme = ref('organization', id('acme'));
const marketing = ref('project', id('marketing'));
const finance = ref('project', id('finance'));
const launchPlan = ref('document', id('launch-plan'));
const budget = ref('document', id('budget'));
const payroll = ref('document', id('payroll'));
const alice = ref('user', id('alice'));
const bob = ref('user', id('bob'));
const carol = ref('user', id('carol'));
const dave = ref('user', id('dave'));

const SCENARIO = [
  relationship(marketing, 'organization', acme),
  relationship(finance, 'organization', acme),
  relationship(launchPlan, 'project', marketing),
  relationship(budget, 'project', marketing),
  relationship(payroll, 'project', finance),
  relationship(acme, 'admin', alice),
  relationship(acme, 'member', bob),
  relationship(marketing, 'editor', bob),
  relationship(acme, 'member', carol),
  relationship(marketing, 'viewer', carol),
  relationship(launchPlan, 'editor', carol),
];

let authz: Authz;
/** The revision of the scenario write: what a row would store, and what the reads below require (§7.3). */
let scenarioToken: ZedToken;

async function removeTestRelationships(): Promise<void> {
  for (const resourceType of Object.keys(VOCABULARY) as ObjectType[]) {
    await authz.deleteRelationships({ resourceType, resourceIdPrefix: PREFIX });
  }
}

beforeAll(async () => {
  loadStackDefaults();
  authz = createAuthz(authzOptionsFromEnv());
  await ensureSchema(authz);
  await removeTestRelationships();
  scenarioToken = await authz.writeRelationships(SCENARIO.map(touch));
});

afterAll(async () => {
  await removeTestRelationships();
  authz.close();
});

describe('schema', () => {
  it('loads, and a second write is reported as unchanged', async () => {
    await expect(ensureSchema(authz)).resolves.toEqual({ action: 'unchanged' });
    await expect(authz.readSchema()).resolves.toContain('definition api_scope');
  });
});

describe('the §6.3 scenario', () => {
  const table = [
    // user, document, edit, view
    [alice, launchPlan, true, true],
    [alice, budget, true, true],
    [alice, payroll, true, true],
    [bob, launchPlan, true, true],
    [bob, budget, true, true],
    [bob, payroll, false, false],
    [carol, launchPlan, true, true],
    [carol, budget, false, true],
    [carol, payroll, false, false],
    [dave, launchPlan, false, false],
  ] as const;

  it.each(table)('%o on %o: edit %s, view %s', async (user, document, edit, view) => {
    const edited = await authz.check({
      resource: document,
      permission: 'edit',
      subject: user,
      consistency: fullyConsistent,
    });
    const viewed = await authz.check({
      resource: document,
      permission: 'view',
      subject: user,
      consistency: fullyConsistent,
    });
    expect([edited.allowed, viewed.allowed]).toEqual([edit, view]);
    expect(edited.token).not.toBe('');
  });

  it('lists exactly Launch plan and Budget as what Carol can view', async () => {
    const ids = await authz.lookupResources({
      type: 'document',
      permission: 'view',
      subject: carol,
      consistency: fullyConsistent,
    });
    expect(ids.sort()).toEqual([budget.id, launchPlan.id]);
  });

  it('lets only project administrators share: Alice can, Carol cannot share what was shared with her', async () => {
    const shares = await authz.bulkCheck(
      [
        { resource: launchPlan, permission: 'share', subject: alice },
        { resource: launchPlan, permission: 'share', subject: bob },
        { resource: launchPlan, permission: 'share', subject: carol },
      ],
      fullyConsistent,
    );
    expect(shares).toEqual([true, false, false]);
  });

  it('answers a bulk check in order, at one consistency', async () => {
    // A cached snapshot may predate the schema write above (one quantization window), so the dashboard's
    // level, minimize_latency, is not usable right after a schema change; the scenario's own token is exact.
    const edits = await authz.bulkCheck(
      [launchPlan, budget, payroll].map((document) => ({
        resource: document,
        permission: 'edit',
        subject: carol,
      })),
      atLeastAsFresh(scenarioToken),
    );
    expect(edits).toEqual([true, false, false]);
    await expect(authz.bulkCheck([], minimizeLatency)).resolves.toEqual([]);
  });

  it('hides the Finance project from members and shows it to the admin', async () => {
    const [bobView, aliceView] = await authz.bulkCheck(
      [
        { resource: finance, permission: 'view', subject: bob },
        { resource: finance, permission: 'view', subject: alice },
      ],
      fullyConsistent,
    );
    expect([bobView, aliceView]).toEqual([false, true]);
  });
});

describe('client authority (§6.7)', () => {
  const dashboardWeb = ref('client', id('dashboard-web'));

  it('resolves the scopes granted to a client with one lookup', async () => {
    await authz.writeRelationships([
      touch(relationship(ref('api_scope', id('documents_read')), 'grantee', dashboardWeb)),
      touch(relationship(ref('api_scope', id('documents_write')), 'grantee', dashboardWeb)),
      touch(
        relationship(ref('api_scope', id('tenancy_write')), 'grantee', ref('client', id('other'))),
      ),
    ]);
    const scopes = await authz.lookupResources({
      type: 'api_scope',
      permission: 'invoke',
      subject: dashboardWeb,
      consistency: fullyConsistent,
    });
    expect(scopes.sort()).toEqual([id('documents_read'), id('documents_write')]);
  });
});

describe('ZedTokens (§7.3)', () => {
  it('returns a token from a write that a later read can require, and a delete revokes at the head', async () => {
    const shared = ref('document', id('shared'));
    const token = await authz.writeRelationships([
      touch(relationship(shared, 'project', marketing)),
      touch(relationship(shared, 'viewer', dave)),
    ]);
    expect(token).not.toBe('');
    const read = await authz.check({
      resource: shared,
      permission: 'view',
      subject: dave,
      consistency: atLeastAsFresh(token),
    });
    expect(read.allowed).toBe(true);

    await authz.writeRelationships([remove(relationship(shared, 'viewer', dave))]);
    const afterRevoke = await authz.check({
      resource: shared,
      permission: 'view',
      subject: dave,
      consistency: fullyConsistent,
    });
    expect(afterRevoke.allowed).toBe(false);
  });

  it('reads the relationships a filter matches, narrowed by relation or subject', async () => {
    const all = await authz.readRelationships(
      { resourceType: 'document', resourceId: launchPlan.id },
      fullyConsistent,
    );
    expect(all).toEqual(
      expect.arrayContaining([
        relationship(launchPlan, 'project', marketing),
        relationship(launchPlan, 'editor', carol),
      ]),
    );
    expect(all).toHaveLength(2);
    expect(
      await authz.readRelationships(
        { resourceType: 'document', resourceId: launchPlan.id, relation: 'editor' },
        fullyConsistent,
      ),
    ).toEqual([relationship(launchPlan, 'editor', carol)]);
    expect(
      await authz.readRelationships(
        {
          resourceType: 'project',
          resourceIdPrefix: PREFIX,
          subject: { type: 'user', id: bob.id },
        },
        fullyConsistent,
      ),
    ).toEqual([relationship(marketing, 'editor', bob)]);
    expect(
      await authz.readRelationships(
        { resourceType: 'document', resourceId: id('no-such-document') },
        fullyConsistent,
      ),
    ).toEqual([]);
  });

  it('deletes by filter and returns the revision', async () => {
    const token = await authz.deleteRelationships({
      resourceType: 'api_scope',
      resourceIdPrefix: PREFIX,
      subject: { type: 'client', id: id('other') },
    });
    expect(token).not.toBe('');
    const remaining = await authz.lookupResources({
      type: 'api_scope',
      permission: 'invoke',
      subject: ref('client', id('other')),
      consistency: atLeastAsFresh(token),
    });
    expect(remaining).toEqual([]);
  });
});
