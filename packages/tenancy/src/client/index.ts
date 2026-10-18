/**
 * `@auth-stack/tenancy/client`: the `TenancyClient` interface and its types, and nothing from the package root
 * (no schema, no database), so that domain packages and BFFs import this subpath alone (docs/README.md §3.1).
 * The HTTP implementation arrives with `tenancy-api` (ticket 16); the in-process one, for tests, lives in the
 * package root.
 */
import { type Policy } from './policy';

export { parsePolicy, policySchema, type Policy } from './policy';

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
}
