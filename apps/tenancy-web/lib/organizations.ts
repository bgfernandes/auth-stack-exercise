/**
 * Tenancy as the pages read it, acting as the signed-in user: every call is an HTTP request to `tenancy-api`
 * with the user's access token, which goes from the session into the user context here and nowhere near a
 * component. The API decides what the user may see (docs/README.md §6.6: a non-member learns nothing).
 */
import { type Member, type OrganizationSummary, type Role } from '@auth-stack/tenancy/client';

import { getCurrentUserContext } from './current-user';
import { tenancy } from './tenancy';

/** Every organization the user may view; undefined when there is no usable session. */
export async function listMyOrganizations(): Promise<OrganizationSummary[] | undefined> {
  const user = await getCurrentUserContext();
  if (!user) return undefined;
  return tenancy().listOrganizations(user);
}

export type OrganizationView =
  | {
      state: 'organization';
      organization: OrganizationSummary;
      members: Member[];
      /** The caller's own role, from their row in the member list: what decides which controls are drawn. */
      callerRole: Role | undefined;
    }
  /** The organization does not exist, or the user may not learn that it does (§6.6). */
  | { state: 'not_found' }
  | { state: 'unauthenticated' };

/** The organization page's data: the organization and its members, as the API shows them to this user. */
export async function organizationView(id: string): Promise<OrganizationView> {
  const user = await getCurrentUserContext();
  if (!user) return { state: 'unauthenticated' };
  const [organization, members] = await Promise.all([
    tenancy().getOrganization(user, id),
    tenancy().listMembers(user, id),
  ]);
  if (!organization || !members) return { state: 'not_found' };
  const callerRole = members.find((member) => member.sub === user.sub)?.role;
  return { state: 'organization', organization, members, callerRole };
}
