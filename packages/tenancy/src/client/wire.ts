/**
 * The wire format of `tenancy-api` (ticket 16): snake_case JSON, as the policy keys already are, parsed on the
 * way in by the HTTP client and produced on the way out by the API from the same definitions, so the two cannot
 * drift apart. The request bodies (ticket 17) carry their shape; the service owns the rules (who may, and on
 * which member) and the API answers `400` from a `ZodError`.
 */
import { z } from 'zod';

import { policySchema } from './policy';

import type { Member, OrganizationSummary } from './index';

export const organizationWire = z
  .object({
    id: z.uuid(),
    name: z.string(),
    is_personal: z.boolean(),
    policy: policySchema,
  })
  .strict();

export type OrganizationWire = z.infer<typeof organizationWire>;

/** `POST /me/provision` */
export const provisionWire = z.object({ organization: organizationWire, created: z.boolean() });

/** `GET /me/organizations` */
export const organizationsWire = z.object({ organizations: z.array(organizationWire) });

const roleWire = z.enum(['admin', 'member']);

export const memberWire = z
  .object({
    sub: z.string().min(1),
    email: z.string().nullable(),
    display_name: z.string().nullable(),
    role: roleWire,
  })
  .strict();

export type MemberWire = z.infer<typeof memberWire>;

/** `GET /organizations/:id/members` */
export const membersWire = z.object({ members: z.array(memberWire) });

/** The body of `PUT /organizations/:id/members`: one member's new role, or `null` to remove the member. */
export const membershipWire = z
  .object({ member_id: z.string().min(1), role: roleWire.nullable() })
  .strict();

export type MembershipWire = z.infer<typeof membershipWire>;

export function toWire(organization: OrganizationSummary): OrganizationWire {
  return {
    id: organization.id,
    name: organization.name,
    is_personal: organization.isPersonal,
    policy: organization.policy,
  };
}

export function fromWire(wire: OrganizationWire): OrganizationSummary {
  return { id: wire.id, name: wire.name, isPersonal: wire.is_personal, policy: wire.policy };
}

export function toMemberWire(member: Member): MemberWire {
  return {
    sub: member.sub,
    email: member.email ?? null,
    display_name: member.displayName ?? null,
    role: member.role,
  };
}

export function fromMemberWire(wire: MemberWire): Member {
  return {
    sub: wire.sub,
    ...(wire.email === null ? {} : { email: wire.email }),
    ...(wire.display_name === null ? {} : { displayName: wire.display_name }),
    role: wire.role,
  };
}
