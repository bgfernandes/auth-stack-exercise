/**
 * `@auth-stack/tenancy`, the package root: schema, migrations, and the service (docs/README.md §3.1). Imported
 * by `tenancy-api` and bootstrap only; everything else imports `@auth-stack/tenancy/client`.
 */
export {
  parsePolicy,
  policySchema,
  type OrganizationSummary,
  type Policy,
  type ProvisionResult,
  type TenancyClient,
  type UserContext,
} from './client/index.js';
export { TenancyError, type TenancyErrorCode } from './errors.js';
export { createInProcessTenancyClient, toSummary } from './in-process-client.js';
export {
  organizations,
  schema,
  users,
  type Organization,
  type TenancySchema,
  type User,
} from './schema.js';
export {
  createTenancyService,
  PERSONAL_ORGANIZATION_NAME,
  type Principal,
  type ProvisionClaims,
  type ProvisionOutcome,
  type Role,
  type TenancyDb,
  type TenancyService,
} from './service.js';
