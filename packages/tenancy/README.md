# `@auth-stack/tenancy`

The tenancy service as a package ([`docs/README.md`](../../docs/README.md) §3.1, §5.1): the users mirror, organizations with their authentication-context policy, and membership, which is written to SpiceDB and never to a table. Two entry points, and which one a caller imports is the ownership rule:

| Import | Holds | Imported by |
| --- | --- | --- |
| `@auth-stack/tenancy/client` | The `TenancyClient` interface, its types (`UserContext`, `OrganizationSummary`, `ProvisionResult`), and the policy schema. No database, no SpiceDB. | Domain packages and BFFs |
| `@auth-stack/tenancy` | The Drizzle schema, the migrations folder, the service, the errors, and the in-process client for tests | `tenancy-api` (ticket 16) and bootstrap |

## Configuration

| Variable | Meaning |
| --- | --- |
| `TENANCY_DATABASE_URL` | `postgres://tenancy:tenancy@postgres:5432/tenancy` in compose; `localhost` from the host (`.env`) |
| `SPICEDB_*` | The SpiceDB connection of [`@auth-stack/authz`](../authz/README.md), which the service checks before every read and write |

## The service

```ts
import { authzOptionsFromEnv, createAuthz, fullyConsistent } from '@auth-stack/authz';
import { createDb } from '@auth-stack/db-core';
import { createTenancyService, schema, TenancyError } from '@auth-stack/tenancy';

const db = createDb(process.env.TENANCY_DATABASE_URL, schema);
const tenancy = createTenancyService({ db, authz: createAuthz(authzOptionsFromEnv()) });

// Login callback (§6.4): idempotent, keyed on the absence of the personal organization, race-safe.
const { user, organization, created } = await tenancy.provisionUser({ sub, email, name });

// Reads name the consistency level (§7.3); phase 1 reads at full consistency.
const org = await tenancy.getOrganization({ sub }, organizationId, fullyConsistent); // undefined: no `view`
const orgs = await tenancy.listOrganizations({ sub }, fullyConsistent);

// Writes check `organization#administer` at full consistency and go to SpiceDB (roles) or Postgres (policy).
await tenancy.setMembership({ sub }, organizationId, memberSub, 'member'); // 'admin' | 'member' | null
await tenancy.setPolicy({ sub }, organizationId, { max_auth_age_seconds: 600 });
```

A method that may not proceed throws `TenancyError` with a `code`: `not_found` (the organization does not exist, or the caller may not learn that it does), `forbidden` (the caller may view it but not do this), `personal_organization` (membership is not managed on a personal organization). Invalid policy input throws a `ZodError`. The API maps these to statuses (ticket 16).

`provisionUser` takes the claims the API resolved from the token and userinfo; it inserts the `users` row with `ON CONFLICT DO NOTHING`, the personal organization behind a partial unique index on `(owner_id) WHERE is_personal`, and the `organization#admin` relationship with TOUCH, inside one transaction, so concurrent first calls converge on one of each.

## The client

```ts
import { type TenancyClient, type UserContext } from '@auth-stack/tenancy/client';

async function dashboard(tenancy: TenancyClient, user: UserContext) {
  const organization = await tenancy.getOrganization(user, organizationId); // undefined for a non-member
}
```

`UserContext` is `{ sub, accessToken }`: the HTTP implementation (ticket 16) forwards the token to `tenancy-api`. For tests, `createInProcessTenancyClient(service, claimsOf)` in the package root wraps the service, with `claimsOf` standing in for what the API learns from the token.

## Schema and migrations

`src/schema.ts` defines `users` and `organizations`; `migrations/` holds what `pnpm db:generate --name <change>` produced from it, applied by `pnpm db:migrate` on the host and by bootstrap in compose ([`@auth-stack/db-core`](../db-core/README.md)). Change the schema and generate in the same commit.

## Checks

```sh
pnpm test packages/tenancy   # unit tests: the policy schema
pnpm test:integration        # against the compose stack: its own database it_tenancy, migrated from zero
```
