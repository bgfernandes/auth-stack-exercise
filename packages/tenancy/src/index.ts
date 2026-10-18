/**
 * `@auth-stack/tenancy`, the package root: schema, migrations, and the service (docs/README.md §3.1). Imported
 * by `tenancy-api` and bootstrap only; everything else imports `@auth-stack/tenancy/client`.
 */
export {
  createHttpTenancyClient,
  fromWire,
  httpTenancyClientFromEnv,
  organizationsWire,
  organizationWire,
  parsePolicy,
  policySchema,
  provisionWire,
  TENANCY_API_SCOPES,
  TenancyClientError,
  toWire,
  type HttpTenancyClient,
  type HttpTenancyClientOptions,
  type OrganizationSummary,
  type OrganizationWire,
  type Policy,
  type ProvisionResult,
  type TenancyClient,
  type UserContext,
} from './client/index';
export { TenancyError, type TenancyErrorCode } from './errors';
export { createInProcessTenancyClient, toSummary } from './in-process-client';
export {
  organizations,
  schema,
  users,
  type Organization,
  type TenancySchema,
  type User,
} from './schema';
export {
  seedOrganization,
  type OrganizationSeed,
  type OrganizationSeedOutcome,
  type SeedUser,
} from './seed';
export {
  createTenancyService,
  PERSONAL_ORGANIZATION_NAME,
  type Principal,
  type ProvisionClaims,
  type ProvisionOutcome,
  type Role,
  type TenancyDb,
  type TenancyService,
} from './service';
