import { describe, expect, it } from '@jest/globals';

import { ACME, acmeSeeds, SEED_USERS } from './seed';

const users = {
  alice: { id: '1001', email: 'alice@example.com' },
  bob: { id: '1002', email: 'bob@example.com' },
  carol: { id: '1003', email: 'carol@example.com' },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('the Acme scenario', () => {
  it('uses fixed, distinct UUIDs and projects it names', () => {
    const ids = [
      ACME.organization.id,
      ...Object.values(ACME.projects).map((project) => project.id),
      ...Object.values(ACME.documents).map((document) => document.id),
    ];
    expect(ids).toHaveLength(new Set(ids).size);
    for (const id of ids) expect(id).toMatch(UUID);
    for (const document of Object.values(ACME.documents)) {
      expect(ACME.projects[document.project]).toBeDefined();
    }
  });

  it('seeds the roles of the §6.3 table from the users Zitadel created', () => {
    const { tenancy, documents } = acmeSeeds(users);
    expect(tenancy).toEqual({
      id: ACME.organization.id,
      name: 'Acme',
      policy: {},
      users: SEED_USERS.map((user) => ({
        sub: users[user.key as keyof typeof users].id,
        email: user.email,
        displayName: `${user.givenName} ${user.familyName}`,
      })),
      roles: [
        { sub: '1001', role: 'admin' },
        { sub: '1002', role: 'member' },
        { sub: '1003', role: 'member' },
      ],
    });
    expect(documents.organizationId).toBe(ACME.organization.id);
    expect(documents.createdBy).toBe('1001');
    expect(documents.projects).toEqual([
      {
        id: ACME.projects.marketing?.id,
        name: 'Marketing',
        roles: [
          { sub: '1002', role: 'editor' },
          { sub: '1003', role: 'viewer' },
        ],
      },
      { id: ACME.projects.finance?.id, name: 'Finance' },
    ]);
    expect(
      documents.documents.map((document) => [document.name, document.projectId, document.roles]),
    ).toEqual([
      ['Launch plan', ACME.projects.marketing?.id, [{ sub: '1003', role: 'editor' }]],
      ['Budget', ACME.projects.marketing?.id, undefined],
      ['Payroll', ACME.projects.finance?.id, undefined],
    ]);
    for (const document of documents.documents) {
      expect(document.value1).not.toBe('');
      expect(document.value2).not.toBe('');
    }
  });

  it('refuses to seed when a user has no Zitadel ID', () => {
    expect(() => acmeSeeds({ alice: users.alice, bob: users.bob })).toThrow(
      /seeded user carol has no Zitadel ID/,
    );
  });
});
