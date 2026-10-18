/**
 * The tenancy service (docs/README.md §5.1, §6.4, §6.6): users mirror, organizations, policy, and membership.
 * Runs behind `tenancy-api` (ticket 16) and in bootstrap; every method checks SpiceDB before touching data,
 * and membership is written to SpiceDB only, never to a table (§5).
 */
import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';

import {
  fullyConsistent,
  ref,
  relationship,
  touch,
  type Authz,
  type Consistency,
  type ZedToken,
} from '@auth-stack/authz';
import { type Db } from '@auth-stack/db-core';

import { parsePolicy } from './client/policy';
import { TenancyError } from './errors';
import { organizations, users, type Organization, type TenancySchema, type User } from './schema';

export type TenancyDb = Db<TenancySchema>;

/** The caller, identified by the `sub` of a verified token; the API fills it in. */
export interface Principal {
  sub: string;
}

/** What provisioning needs from the IdP: `sub` from the token, `email` and `name` from userinfo (§6.4). */
export interface ProvisionClaims {
  sub: string;
  email: string;
  name: string;
}

export interface ProvisionOutcome {
  user: User;
  organization: Organization;
  created: boolean;
}

export type Role = 'admin' | 'member';

export interface TenancyService {
  /**
   * Idempotent and race-safe (§6.4): the users row with `ON CONFLICT DO NOTHING`, the personal organization
   * behind its partial unique index, the `organization#admin` relationship with TOUCH. Returns the existing
   * organization after the first call.
   */
  provisionUser(claims: ProvisionClaims): Promise<ProvisionOutcome>;
  /** The users row of a `sub`, if provisioning has created it; what tells the API whether userinfo is needed (§6.4). */
  getUser(sub: string): Promise<User | undefined>;
  /** The organization if the principal holds `organization#view`, undefined otherwise or when it does not exist. */
  getOrganization(
    principal: Principal,
    id: string,
    consistency: Consistency,
  ): Promise<Organization | undefined>;
  /** Every organization the principal may view, by name. */
  listOrganizations(principal: Principal, consistency: Consistency): Promise<Organization[]>;
  /**
   * Grants `role` to the member (replacing the other role) or, with null, removes both; `organization#administer`
   * at full consistency. Not on a personal organization. Returns the token of the write.
   */
  setMembership(
    principal: Principal,
    organizationId: string,
    memberSub: string,
    role: Role | null,
  ): Promise<ZedToken>;
  /** Replaces the policy after validating it; `organization#administer` at full consistency. */
  setPolicy(principal: Principal, organizationId: string, policy: unknown): Promise<Organization>;
}

export const PERSONAL_ORGANIZATION_NAME = 'Personal';

const ROLES: readonly Role[] = ['admin', 'member'];

export function createTenancyService(deps: { db: TenancyDb; authz: Authz }): TenancyService {
  const { db, authz } = deps;

  async function allowed(
    principal: Principal,
    organizationId: string,
    permission: 'view' | 'administer',
    consistency: Consistency,
  ): Promise<boolean> {
    const result = await authz.check({
      resource: ref('organization', organizationId),
      permission,
      subject: ref('user', principal.sub),
      consistency,
    });
    return result.allowed;
  }

  async function load(id: string): Promise<Organization | undefined> {
    const rows = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    return rows[0];
  }

  /** The organization the principal administers, or the error the caller gets instead. */
  async function administered(principal: Principal, id: string): Promise<Organization> {
    const organization = await load(id);
    if (!organization) throw new TenancyError('not_found', 'organization not found');
    if (await allowed(principal, id, 'administer', fullyConsistent)) return organization;
    if (await allowed(principal, id, 'view', fullyConsistent)) {
      throw new TenancyError('forbidden', 'organization#administer required');
    }
    throw new TenancyError('not_found', 'organization not found');
  }

  return {
    async provisionUser(claims) {
      return db.transaction(async (tx) => {
        await tx
          .insert(users)
          .values({ id: claims.sub, email: claims.email, displayName: claims.name })
          .onConflictDoNothing();
        const [user] = await tx.select().from(users).where(eq(users.id, claims.sub)).limit(1);
        if (!user) throw new Error('users row missing after insert');

        const personal = { ownerId: claims.sub, isPersonal: true } as const;
        const [created] = await tx
          .insert(organizations)
          .values({ id: randomUUID(), name: PERSONAL_ORGANIZATION_NAME, ...personal })
          // `where` names the partial index's predicate, as Postgres requires for ON CONFLICT on one.
          .onConflictDoNothing({
            target: organizations.ownerId,
            where: eq(organizations.isPersonal, true),
          })
          .returning();
        if (created) {
          // Inside the transaction: if SpiceDB refuses, the rows roll back and the next call starts over.
          await authz.writeRelationships([
            touch(relationship(ref('organization', created.id), 'admin', ref('user', claims.sub))),
          ]);
          return { user, organization: created, created: true };
        }
        // Lost the race, or a later call: the index made the winner visible once it committed.
        const [existing] = await tx
          .select()
          .from(organizations)
          .where(and(eq(organizations.ownerId, claims.sub), eq(organizations.isPersonal, true)))
          .limit(1);
        if (!existing) throw new Error('personal organization missing after conflict');
        return { user, organization: existing, created: false };
      });
    },

    async getUser(sub) {
      const rows = await db.select().from(users).where(eq(users.id, sub)).limit(1);
      return rows[0];
    },

    async getOrganization(principal, id, consistency) {
      if (!(await allowed(principal, id, 'view', consistency))) return undefined;
      return load(id);
    },

    async listOrganizations(principal, consistency) {
      const ids = await authz.lookupResources({
        type: 'organization',
        permission: 'view',
        subject: ref('user', principal.sub),
        consistency,
      });
      const visible = ids.filter(isUuid);
      if (visible.length === 0) return [];
      return db
        .select()
        .from(organizations)
        .where(inArray(organizations.id, visible))
        .orderBy(organizations.name, organizations.id);
    },

    async setMembership(principal, organizationId, memberSub, role) {
      const organization = await administered(principal, organizationId);
      if (organization.isPersonal) {
        throw new TenancyError('personal_organization', 'no membership on a personal organization');
      }
      const member = { type: 'user', id: memberSub } as const;
      const resource = ref('organization', organizationId);
      // The roles the member must not hold afterwards go first, by filter, so a missing one is a no-op.
      let token: ZedToken | undefined;
      for (const other of ROLES.filter((candidate) => candidate !== role)) {
        token = await authz.deleteRelationships({
          resourceType: 'organization',
          resourceId: organizationId,
          relation: other,
          subject: member,
        });
      }
      if (role)
        token = await authz.writeRelationships([
          touch(relationship(resource, role, ref('user', memberSub))),
        ]);
      if (!token) throw new Error('membership change produced no token');
      return token;
    },

    async setPolicy(principal, organizationId, policy) {
      await administered(principal, organizationId);
      const parsed = parsePolicy(policy);
      const [updated] = await db
        .update(organizations)
        .set({ policy: parsed })
        .where(eq(organizations.id, organizationId))
        .returning();
      if (!updated) throw new TenancyError('not_found', 'organization not found');
      return updated;
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SpiceDB may hold IDs that are not rows here (another environment's, a test's); never let one reach a uuid column. */
function isUuid(id: string): boolean {
  return UUID.test(id);
}
