/**
 * `@auth-stack/tenancy/client`: the HTTP client and its request/response types only (ticket 7 and 16).
 * Domain packages and BFFs import this subpath; the package root (schema, migrations, services) is for
 * tenancy-api and bootstrap alone.
 */
export const packageName = '@auth-stack/tenancy/client';
