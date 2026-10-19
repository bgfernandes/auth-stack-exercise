# `@auth-stack/client-scopes`

> **⚠️ This package is a workaround for a vendor limitation, not the intended design.** Client authority (which scopes an application was granted, RFC 6749 §3.3) belongs in the authorization server: the provider defines the scopes, shows the consent screen, and puts the granted `scope` in the access token, and the API reads it from there. Zitadel does none of that, so this project stores client-to-scope grants in SpiceDB and resolves them by the token's `client_id`.
>
> The package exists so that the APIs enforce a scope gate from their first version and never need a retrofit when external clients arrive ([`docs/README.md`](../../docs/README.md) §6.7), and it is kept apart from `@auth-stack/authz` so that it can be deleted as a unit.

## What it holds

- `scopeObjectId('documents:write')` is `documents_write`, the `api_scope` object ID (SpiceDB object IDs cannot contain a colon); `scopeFromObjectId` maps back, which is only safe because the scope grammar `<api>:<verb>` has no underscore. `apiScope(scope)` and `client(clientId)` are the typed references.
- `createScopeResolver(authz, { ttlMs, consistency })`: the SpiceDB-backed `ScopeResolver` of `@auth-stack/auth`. One `LookupResources(api_scope, invoke, client:<client_id>)` per client, cached for a minute (empty results too; concurrent callers share one lookup), at `minimizeLatency` because bootstrap writes the grants before the APIs start and they change rarely. `invalidate(clientId?)` drops the cache.

## Usage

```ts
import { bearerOptionsFromEnv, createBearerVerifier } from '@auth-stack/auth';
import { bearerPlugin } from '@auth-stack/auth/fastify';
import { authzOptionsFromEnv, createAuthz } from '@auth-stack/authz';
import { createScopeResolver } from '@auth-stack/client-scopes';

const authz = createAuthz(authzOptionsFromEnv());
await app.register(bearerPlugin, {
  verifier: createBearerVerifier(bearerOptionsFromEnv()),
  scopes: createScopeResolver(authz),
});
```

Bootstrap grants every first-party client the scopes of the calls it makes (`dashboard-web` both scopes of both APIs; `tenancy-web` both of `tenancy-api` and `documents:write`, for the one call of its login), one relationship per scope:

```ts
import { relationship, touch } from '@auth-stack/authz';
import { apiScope, client } from '@auth-stack/client-scopes';

await authz.writeRelationships([touch(relationship(apiScope('tenancy:read'), 'grantee', client(clientId)))]);
```

## Deleting it

The day the provider emits `scope` in access tokens (or the stack moves to one that does):

1. In every API, replace `createScopeResolver(authz)` with `fromScopeClaim` from `@auth-stack/auth`.
2. Remove the grant writing from bootstrap and delete the `client` and `api_scope` relationships.
3. Delete this package and the `client` and `api_scope` definitions from `packages/authz/schema.zed` (and `VOCABULARY`).

The APIs' routes and their `requireScope(...)` declarations do not change.

## Checks

```sh
pnpm test packages/client-scopes   # the ID mapping and the cache, with a fake authz
pnpm test:integration              # the lookup against the compose SpiceDB
```
