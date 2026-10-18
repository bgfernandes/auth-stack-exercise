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
  remove,
  touch,
  type Authz,
  type Consistency,
  type RelationshipUpdate,
  type ZedToken,
} from '@auth-stack/authz';
import { type Db } from '@auth-stack/db-core';

import { type Member, type Role } from './client/index';
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
   * The members of an organization the principal may view (§6.8: every member sees the list), admins first,
   * each with what the `users` mirror knows; undefined when the principal may not view it or it does not exist.
   */
  listMembers(
    principal: Principal,
    organizationId: string,
    consistency: Consistency,
  ): Promise<Member[] | undefined>;
  /**
   * Changes a current member's role, or removes the member with null; `organization#administer` at full
   * consistency, not on a personal organization. A user who holds no role is refused (`not_a_member`): a first
   * role comes from an invitation (§6.8, ticket 17a) or the seed, never from an administrator naming a `sub`.
   * The last administrator cannot be demoted or removed (`last_admin`). Returns the token of the write.
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

function isRole(relation: string): relation is Role {
  return (ROLES as readonly string[]).includes(relation);
}

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

  /** The organization-level roles as SpiceDB holds them: by `sub`, the relations (`admin`, `member`) held. */
  async function organizationRoles(
    organizationId: string,
    consistency: Consistency,
  ): Promise<Map<string, Set<Role>>> {
    const found = await authz.readRelationships(
      { resourceType: 'organization', resourceId: organizationId },
      consistency,
    );
    const roles = new Map<string, Set<Role>>();
    for (const { relation, subject } of found) {
      if (subject.type !== 'user' || !isRole(relation)) continue;
      const held = roles.get(subject.id) ?? new Set<Role>();
      held.add(relation);
      roles.set(subject.id, held);
    }
    return roles;
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

    async listMembers(principal, organizationId, consistency) {
      if (!(await allowed(principal, organizationId, 'view', consistency))) return undefined;
      const roles = await organizationRoles(organizationId, consistency);
      const subs = [...roles.keys()];
      const rows =
        subs.length === 0 ? [] : await db.select().from(users).where(inArray(users.id, subs));
      const known = new Map(rows.map((row) => [row.id, row]));
      const members: Member[] = [];
      for (const [sub, held] of roles) {
        const row = known.get(sub);
        members.push({
          sub,
          ...(row ? { email: row.email, displayName: row.displayName } : {}),
          // A member who holds both relations (a repaired seed, a race) is an admin: `administer = admin`.
          role: held.has('admin') ? 'admin' : 'member',
        });
      }
      return members.sort(compareMembers);
    },

    async setMembership(principal, organizationId, memberSub, role) {
      const organization = await administered(principal, organizationId);
      if (organization.isPersonal) {
        throw new TenancyError('personal_organization', 'no membership on a personal organization');
      }
      const resource = ref('organization', organizationId);
      const member = ref('user', memberSub);
      // Full consistency, like the check above: the roles a change is based on are the ones really there.
      const roles = await organizationRoles(organizationId, fullyConsistent);
      const held = roles.get(memberSub);
      if (!held)
        throw new TenancyError('not_a_member', 'the user holds no role in the organization');
      if (held.has('admin') && role !== 'admin') {
        const admins = [...roles].filter(([, relations]) => relations.has('admin'));
        if (admins.length === 1) {
          throw new TenancyError(
            'last_admin',
            'the organization would be left with no administrator',
          );
        }
      }
      // One atomic write: the role to hold TOUCHed, the roles held and no longer wanted deleted.
      const updates: RelationshipUpdate[] = [];
      if (role) updates.push(touch(relationship(resource, role, member)));
      for (const other of held) {
        if (other !== role) updates.push(remove(relationship(resource, other, member)));
      }
      return authz.writeRelationships(updates);
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

/** Admins first, then by what the list shows (name, else email, else `sub`), then by `sub` for a stable order. */
function compareMembers(a: Member, b: Member): number {
  if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
  const label = (member: Member) => member.displayName ?? member.email ?? member.sub;
  return label(a).localeCompare(label(b)) || a.sub.localeCompare(b.sub);
}

/** SpiceDB may hold IDs that are not rows here (another environment's, a test's); never let one reach a uuid column. */
function isUuid(id: string): boolean {
  return UUID.test(id);
}
