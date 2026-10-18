/**
 * The wire format of `tenancy-api` (ticket 16): snake_case JSON, as the policy keys already are, parsed on the
 * way in by the HTTP client and produced on the way out by the API from the same definitions, so the two cannot
 * drift apart.
 */
import { z } from 'zod';

import { policySchema } from './policy';

import type { OrganizationSummary } from './index';

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
