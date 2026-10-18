/**
 * `@auth-stack/tenancy/client`: the `TenancyClient` interface and its types, and nothing from the package root
 * (no schema, no database), so that domain packages and BFFs import this subpath alone (docs/README.md §3.1).
 * The HTTP implementation (`createHttpTenancyClient`) lives here; the in-process one, for tests, in the package
 * root.
 */
import { type Policy } from './policy';

export {
  createHttpTenancyClient,
  httpTenancyClientFromEnv,
  isTenancyClientError,
  TenancyClientError,
  type HttpTenancyClient,
  type HttpTenancyClientOptions,
} from './http';
export { parsePolicy, policySchema, type Policy } from './policy';
export {
  fromMemberWire,
  fromWire,
  memberWire,
  membershipWire,
  membersWire,
  organizationsWire,
  organizationWire,
  provisionWire,
  toMemberWire,
  toWire,
  type MemberWire,
  type MembershipWire,
  type OrganizationWire,
} from './wire';

/**
 * The scope vocabulary of `tenancy-api` (docs/README.md §6.7): what its routes require and what bootstrap grants
 * to every first-party client that calls it.
 */
export const TENANCY_API_SCOPES = {
  read: 'tenancy:read',
  write: 'tenancy:write',
} as const;

/** The user a BFF or domain acts for: the `sub` of the session and the access token it forwards to the APIs. */
export interface UserContext {
  sub: string;
  accessToken: string;
}

/** What a caller outside the tenancy service learns about an organization. */
export interface OrganizationSummary {
  id: string;
  name: string;
  isPersonal: boolean;
  policy: Policy;
}

/** The organization-level roles of docs/README.md §6.2: `organization#admin` and `organization#member`. */
export type Role = 'admin' | 'member';

/**
 * One member of an organization (§6.8: the member list is what every member sees and what the share picker
 * offers). The name and email come from the `users` mirror (§5.1) and are missing for a member whose row was
 * never written, which is why the `sub`, the identifier every grant names, is what a caller keys on.
 */
export interface Member {
  sub: string;
  email?: string;
  displayName?: string;
  role: Role;
}

export interface ProvisionResult {
  /** The user's personal organization (§6.4). */
  organization: OrganizationSummary;
  /** Whether this call created it; false on every call after the first. */
  created: boolean;
}

/** The calls every domain and BFF makes into tenancy (§6.6), each on behalf of the user. */
export interface TenancyClient {
  /** Idempotent: creates the user mirror and the personal organization on the first call for a `sub`. */
  provisionUser(user: UserContext): Promise<ProvisionResult>;
  /** The organization if the user may view it, undefined otherwise (a non-member learns nothing, §6.6). */
  getOrganization(user: UserContext, id: string): Promise<OrganizationSummary | undefined>;
  /** Every organization the user may view. */
  listOrganizations(user: UserContext): Promise<OrganizationSummary[]>;
  /** The members of an organization the user may view, admins first; undefined when the user may not view it. */
  listMembers(user: UserContext, organizationId: string): Promise<Member[] | undefined>;
  /**
   * Changes a current member's role, or removes the member with `null` (§6.8: a first role comes from an
   * invitation, never from here). `organization#administer`; a refusal throws `TenancyClientError` with the
   * API's code (`forbidden`, `not_found`, `personal_organization`, `not_a_member`, `last_admin`).
   */
  setMembership(
    user: UserContext,
    organizationId: string,
    memberSub: string,
    role: Role | null,
  ): Promise<void>;
  /** Replaces the organization's authentication-context policy (§9.1); `organization#administer`. */
  setPolicy(
    user: UserContext,
    organizationId: string,
    policy: Policy,
  ): Promise<OrganizationSummary>;
}
