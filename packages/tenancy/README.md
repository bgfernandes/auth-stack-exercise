# `@auth-stack/tenancy`

The tenancy service as a package ([`docs/README.md`](../../docs/README.md) §3.1, §5.1): the users mirror, organizations with their authentication-context policy, and membership, which is written to SpiceDB and never to a table. Two entry points, and which one a caller imports is the ownership rule:

| Import | Holds | Imported by |
| --- | --- | --- |
| `@auth-stack/tenancy/client` | The `TenancyClient` interface, its types (`UserContext`, `OrganizationSummary`, `Member`, `Role`, `ProvisionResult`), the HTTP implementation (`createHttpTenancyClient`), the wire format of `tenancy-api`, its scope vocabulary (`TENANCY_API_SCOPES`), and the policy schema. No database, no SpiceDB. | Domain packages and BFFs |
| `@auth-stack/tenancy` | The Drizzle schema, the migrations folder, the service, the errors, and the in-process client for tests | `tenancy-api` and bootstrap |
| `@auth-stack/tenancy/testing` | The `TenancyClient` contract test, run against both implementations | The two integration tests |

## Configuration

| Variable | Meaning |
| --- | --- |
| `TENANCY_DATABASE_URL` | `postgres://tenancy:tenancy@postgres:5432/tenancy` in compose; `localhost` from the host (`.env`) |
| `TENANCY_API_URL` | Where the HTTP client reaches `tenancy-api`: `http://tenancy-api:4001` in compose, `http://localhost:4001` under Tilt; bootstrap writes it to each BFF's env file |
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
const members = await tenancy.listMembers({ sub }, organizationId, fullyConsistent); // undefined: no `view`

// Writes check `organization#administer` at full consistency and go to SpiceDB (roles) or Postgres (policy).
await tenancy.setMembership({ sub }, organizationId, memberSub, 'member'); // 'admin' | 'member' | null
await tenancy.setPolicy({ sub }, organizationId, { max_auth_age_seconds: 600 });
```

A method that may not proceed throws `TenancyError` with a `code`: `not_found` (the organization does not exist, or the caller may not learn that it does), `forbidden` (the caller may view it but not do this), `personal_organization` (membership is not managed on a personal organization), `not_a_member` (the named user holds no role), `last_admin` (the change would leave no administrator). Invalid policy input throws a `ZodError`. `tenancy-api` maps these to `404`, `403`, `409`, `400`, and `409`, with a body of `{ "error": "<code>" }`.

`listMembers` reads the organization's `admin` and `member` relationships from SpiceDB and joins them to the `users` mirror: every member sees the list (§6.8, it is the share picker's source), admins first, and a member whose mirror row was never written (a `sub` that changed with a reset IdP, §6.3) is listed with the `sub` alone. `setMembership` changes a **current** member's role or removes the member: a user who holds no role is refused with `not_a_member`, because a first role comes from an invitation (§6.8, ticket 17a) or from the seed, never from an administrator naming a `sub`; and the last administrator can be neither demoted nor removed (`last_admin`). The change is one atomic SpiceDB write (the role to hold TOUCHed, the roles held and no longer wanted deleted), decided on relationships read at full consistency.

`getUser(sub)` is what the API checks before provisioning: when the row exists, nothing is asked of the IdP; when it does not, the API fetches the email and name from userinfo with the caller's token (§6.4, "on the first call for that `sub`").

`provisionUser` takes the claims the API resolved from the token and userinfo; it inserts the `users` row with `ON CONFLICT DO NOTHING`, the personal organization behind a partial unique index on `(owner_id) WHERE is_personal`, and the `organization#admin` relationship with TOUCH, inside one transaction, so concurrent first calls converge on one of each.

## Seeding

```ts
import { seedOrganization } from '@auth-stack/tenancy';

const { organization, created, createdUsers, token } = await seedOrganization(
  { db, authz },
  {
    id: '5eed0000-0000-4000-8000-000000000001', // fixed, so reruns match the same row
    name: 'Acme',
    users: [{ sub, email: 'alice@example.com', displayName: 'Alice Adams' }],
    roles: [{ sub, role: 'admin' }], // 'admin' | 'member'
  },
);
```

For bootstrap (`docs/README.md` §6.3), which is trusted and has no principal to check: the `users` mirror rows and the organization are created if absent and never changed afterwards (a row that exists keeps what provisioning, an administrator, or an earlier run wrote), and the `organization#<role>@user:<sub>` relationships are TOUCHed on every run, in one transaction, so a role removed by hand or a `sub` that changed with a reset IdP is repaired by the next run. The returned `token` is the relationship write's, for the caller to store on the content it seeds next (§7.3). Every ID comes from the caller: a test seeds a scenario of its own under random IDs.

## The client

```ts
import { httpTenancyClientFromEnv, type TenancyClient, type UserContext } from '@auth-stack/tenancy/client';

const tenancy = httpTenancyClientFromEnv(); // TENANCY_API_URL; or createHttpTenancyClient({ baseUrl, fetch, cacheTtlMs })

async function callback(user: UserContext) {
  const { organization, created } = await tenancy.provisionUser(user); // idempotent (§6.4)
}

async function dashboard(user: UserContext) {
  const organization = await tenancy.getOrganization(user, organizationId); // undefined for a non-member
  const organizations = await tenancy.listOrganizations(user);
  const members = await tenancy.listMembers(user, organizationId); // undefined for a non-member
}

async function manage(user: UserContext) {
  await tenancy.setMembership(user, organizationId, memberSub, 'admin'); // 'admin' | 'member' | null (remove)
  const updated = await tenancy.setPolicy(user, organizationId, { require_mfa: true });
}
```

`UserContext` is `{ sub, accessToken }`: the HTTP implementation sends the token as `Authorization: Bearer` on every call, and `tenancy-api` acts for the `sub` the token proves. `getOrganization` answers, found or not, are cached per user and organization for a minute (`cacheTtlMs`), with concurrent asks for the same pair deduplicated; the cache is keyed by the user because an answer is a permission decision for that user, so a fresh membership shows within a minute and `invalidate(sub)` drops it sooner; a `setPolicy` answer replaces the cached organization for that user, so the page that saved the policy reads it back at once. `provisionUser`, `listOrganizations`, `listMembers`, and the writes always call the API. Any answer outside the contract (a `401` on an expired token, a `502` when the IdP's userinfo is down, a `5xx`, and the refusals of a write: `403 forbidden`, `404 not_found`, `409 personal_organization`, `400 not_a_member`, `409 last_admin`, `400 invalid_input`) throws `TenancyClientError` with the `status` and the API's error `code`, which a caller recognizes with `isTenancyClientError(error)` (by name and shape, never `instanceof`: a Next.js route handler and a server component get separate copies of the module); a body that is not the wire format throws a `ZodError`.

The wire format is snake_case JSON, defined once (`organizationWire`, `provisionWire`, `organizationsWire`, `memberWire`, `membersWire`, `membershipWire`, with `toWire`/`fromWire` and `toMemberWire`/`fromMemberWire`) and used by the API to answer and by the client to parse: `{ "id", "name", "is_personal", "policy" }` per organization, `{ "organization", "created" }` from `POST /me/provision`, `{ "organizations": [...] }` from `GET /me/organizations`, `{ "members": [{ "sub", "email", "display_name", "role" }] }` from `GET /organizations/:id/members` (`email` and `display_name` are `null` without a mirror row), `{ "member_id", "role" }` as the body of `PUT /organizations/:id/members` (`role` `null` removes; `204` on success), and the policy itself as the body of `PUT /organizations/:id/policy`, answered with the organization. `TENANCY_API_SCOPES` (`tenancy:read`, `tenancy:write`) names what the routes require and what bootstrap grants to each first-party client.

For tests, `createInProcessTenancyClient(service, claimsOf)` in the package root wraps the service, with `claimsOf` standing in for what the API learns from the token, and `describeTenancyClientContract(name, harness)` from `@auth-stack/tenancy/testing` is the contract both implementations pass; the harness supplies a user factory and `sharedOrganization(name, members)`, which seeds an organization with roles the way bootstrap does, since the client cannot grant a first role.

## Schema and migrations

`src/schema.ts` defines `users` and `organizations`; `migrations/` holds what `pnpm db:generate --name <change>` produced from it, applied by `pnpm db:migrate` on the host and by bootstrap in compose ([`@auth-stack/db-core`](../db-core/README.md)). Change the schema and generate in the same commit.

## Checks

```sh
pnpm test packages/tenancy   # unit tests: the policy schema, the HTTP client's cache and error mapping
pnpm test:integration        # against the compose stack: its own database it_tenancy, migrated from zero; the service (provisioning, reads, the member list, membership and policy writes), the seed, the client contract over the service, and over tenancy-api (apps/tenancy-api)
```
