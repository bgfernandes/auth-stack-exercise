/**
 * Seeding (docs/README.md §6.3): a shared organization with its users mirror rows and its organization-level
 * roles, written by bootstrap, which is trusted and has no principal to check. Every ID comes from the caller
 * so a test can seed a scenario of its own; the Acme constants live in bootstrap. Idempotent: rows are created
 * if absent and never changed afterwards, relationships are TOUCHed on every run, so a role removed by hand or
 * a user whose `sub` changed with a reset IdP is repaired by the next run.
 */
import { eq } from 'drizzle-orm';

import { ref, relationship, touch, type Authz, type ZedToken } from '@auth-stack/authz';

import { type Role } from './client/index';
import { type Policy } from './client/policy';
import { organizations, users, type Organization } from './schema';
import { type TenancyDb } from './service';

export interface SeedUser {
  /** The Zitadel `sub`. */
  sub: string;
  email: string;
  displayName: string;
}

export interface OrganizationSeed {
  /** A fixed UUID, so reruns match the same row. */
  id: string;
  name: string;
  /** `{}` by default: no authentication-context floor (§9.1). */
  policy?: Policy;
  /** The mirror rows to create if absent (§5.1); a row that exists keeps what provisioning or a prior run wrote. */
  users: SeedUser[];
  /** `organization#<role>@user:<sub>` for each, TOUCHed on every run. */
  roles: { sub: string; role: Role }[];
}

export interface OrganizationSeedOutcome {
  organization: Organization;
  /** Whether this run created the row. */
  created: boolean;
  /** The `sub`s whose mirror row this run created. */
  createdUsers: string[];
  /** The token of the relationship write, for the caller to store on content it seeds next (§7.3). */
  token: ZedToken;
}

export async function seedOrganization(
  deps: { db: TenancyDb; authz: Authz },
  seed: OrganizationSeed,
): Promise<OrganizationSeedOutcome> {
  const { db, authz } = deps;
  // Both refs throw on an ID SpiceDB would refuse, before anything is written.
  const resource = ref('organization', seed.id);
  const updates = seed.roles.map(({ sub, role }) =>
    touch(relationship(resource, role, ref('user', sub))),
  );
  return db.transaction(async (tx) => {
    const createdUsers: string[] = [];
    for (const user of seed.users) {
      const inserted = await tx
        .insert(users)
        .values({ id: user.sub, email: user.email, displayName: user.displayName })
        .onConflictDoNothing()
        .returning({ id: users.id });
      if (inserted.length > 0) createdUsers.push(user.sub);
    }
    const [inserted] = await tx
      .insert(organizations)
      .values({ id: seed.id, name: seed.name, policy: seed.policy ?? {} })
      .onConflictDoNothing({ target: organizations.id })
      .returning();
    const organization =
      inserted ??
      (await tx.select().from(organizations).where(eq(organizations.id, seed.id)).limit(1))[0];
    if (!organization) throw new Error('organization missing after insert');
    // Inside the transaction: if SpiceDB refuses, the rows roll back and the next run starts over.
    const token = await authz.writeRelationships(updates);
    return { organization, created: inserted !== undefined, createdUsers, token };
  });
}
