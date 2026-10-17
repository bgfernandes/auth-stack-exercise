/**
 * `TenancyClient` over the service in the same process, for unit and integration tests of the callers
 * (docs/README.md §6.4). The HTTP implementation (ticket 16) resolves the token at `tenancy-api` with the bearer
 * plugin and userinfo; here the caller supplies that resolution.
 */
import { fullyConsistent } from '@auth-stack/authz';

import { type OrganizationSummary, type TenancyClient, type UserContext } from './client/index.js';
import { type Organization } from './schema.js';
import { type ProvisionClaims, type TenancyService } from './service.js';

export function toSummary(organization: Organization): OrganizationSummary {
  return {
    id: organization.id,
    name: organization.name,
    isPersonal: organization.isPersonal,
    policy: organization.policy,
  };
}

export function createInProcessTenancyClient(
  service: TenancyService,
  /** What the API learns from the token and userinfo: the test decides. */
  claimsOf: (user: UserContext) => Promise<ProvisionClaims>,
): TenancyClient {
  return {
    async provisionUser(user) {
      const outcome = await service.provisionUser(await claimsOf(user));
      return { organization: toSummary(outcome.organization), created: outcome.created };
    },
    async getOrganization(user, id) {
      // Phase 1 reads at full consistency (ticket 16); ticket 21 revisits the listing levels.
      const organization = await service.getOrganization({ sub: user.sub }, id, fullyConsistent);
      return organization && toSummary(organization);
    },
    async listOrganizations(user) {
      const organizations = await service.listOrganizations({ sub: user.sub }, fullyConsistent);
      return organizations.map(toSummary);
    },
  };
}
