/**
 * The seeded scenario of docs/README.md §6.3: three users in Zitadel, the Acme organization with its roles
 * (tenancy), and its projects, documents, and shares (documents). The rows have fixed UUIDs so every run
 * matches the same ones; the §6.3 names (`acme`, `marketing`, `launch-plan`) are labels, which seed.json keeps
 * next to the IDs for the end-to-end tests. Personal workspaces are not seeded: each user gets one on first
 * login (§6.4).
 */
import { type DocumentsSeed } from '@auth-stack/documents';
import { type OrganizationSeed } from '@auth-stack/tenancy';

export interface SeedUser {
  /** Key in seed.json and in the end-to-end tests. */
  key: string;
  /** Username and email; an email as username keeps the login name free of the organization domain suffix. */
  email: string;
  givenName: string;
  familyName: string;
}

export const SEED_USERS: readonly SeedUser[] = [
  { key: 'alice', email: 'alice@example.com', givenName: 'Alice', familyName: 'Adams' },
  { key: 'bob', email: 'bob@example.com', givenName: 'Bob', familyName: 'Baker' },
  { key: 'carol', email: 'carol@example.com', givenName: 'Carol', familyName: 'Clark' },
];

/** The §6.3 scenario by label; what seed.json carries so a test can address a document without the dashboard. */
export interface Scenario {
  organization: { id: string; name: string };
  projects: Record<string, { id: string; name: string }>;
  documents: Record<string, { id: string; name: string; project: string }>;
}

export const ACME: Scenario = {
  organization: { id: '5eed0000-0000-4000-8000-000000000001', name: 'Acme' },
  projects: {
    marketing: { id: '5eed0000-0000-4000-8000-000000000011', name: 'Marketing' },
    finance: { id: '5eed0000-0000-4000-8000-000000000012', name: 'Finance' },
  },
  documents: {
    'launch-plan': {
      id: '5eed0000-0000-4000-8000-000000000021',
      name: 'Launch plan',
      project: 'marketing',
    },
    budget: { id: '5eed0000-0000-4000-8000-000000000022', name: 'Budget', project: 'marketing' },
    payroll: { id: '5eed0000-0000-4000-8000-000000000023', name: 'Payroll', project: 'finance' },
  },
};

/** The two values each document starts with; a rerun never resets them. */
const VALUES: Record<string, { value1: string; value2: string }> = {
  'launch-plan': { value1: 'Launch window', value2: 'Q1' },
  budget: { value1: 'Approved spend', value2: '120000' },
  payroll: { value1: 'Pay run', value2: 'Monthly' },
};

/** What bootstrap seeds, from the Zitadel IDs the users were created with (their `sub`), per the §6.3 table. */
export function acmeSeeds(users: Record<string, { id: string; email: string }>): {
  tenancy: OrganizationSeed;
  documents: DocumentsSeed;
} {
  const sub = (key: string): string => {
    const user = users[key];
    if (!user) throw new Error(`seeded user ${key} has no Zitadel ID`);
    return user.id;
  };
  const alice = sub('alice');
  const bob = sub('bob');
  const carol = sub('carol');
  const { marketing, finance } = ACME.projects;
  if (!marketing || !finance) throw new Error('scenario projects missing');
  return {
    tenancy: {
      id: ACME.organization.id,
      name: ACME.organization.name,
      policy: {},
      users: SEED_USERS.map((user) => ({
        sub: sub(user.key),
        email: user.email,
        displayName: `${user.givenName} ${user.familyName}`,
      })),
      roles: [
        { sub: alice, role: 'admin' },
        { sub: bob, role: 'member' },
        { sub: carol, role: 'member' },
      ],
    },
    documents: {
      organizationId: ACME.organization.id,
      createdBy: alice,
      projects: [
        {
          ...marketing,
          roles: [
            { sub: bob, role: 'editor' },
            { sub: carol, role: 'viewer' },
          ],
        },
        { ...finance },
      ],
      documents: Object.entries(ACME.documents).map(([label, document]) => {
        const project = ACME.projects[document.project];
        const values = VALUES[label];
        if (!project || !values) throw new Error(`scenario document ${label} is incomplete`);
        return {
          id: document.id,
          projectId: project.id,
          name: document.name,
          ...values,
          ...(label === 'launch-plan' ? { roles: [{ sub: carol, role: 'editor' as const }] } : {}),
        };
      }),
    },
  };
}
