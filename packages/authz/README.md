# `@auth-stack/authz`

The one place SpiceDB details live: the schema (`schema.zed`), a client over `@authzed/authzed-node`, and typed helpers so that a misspelled relation or permission, or a subject of the wrong type, fails `tsc` rather than a request. The model behind the schema is in [`docs/README.md`](../../docs/README.md) §6; the consistency rules are §7.3.

## Configuration

`authzOptionsFromEnv()` reads three variables; `createAuthz(options)` takes the same values directly.

| Variable | Meaning |
| --- | --- |
| `SPICEDB_ENDPOINT` | `host:port` of SpiceDB's gRPC API: `spicedb:50051` inside compose, `localhost:50051` from the host |
| `SPICEDB_PRESHARED_KEY` | The key every client presents as a bearer token (`.env`) |
| `SPICEDB_INSECURE` | `true` for plaintext gRPC, which the development stack uses; unset or anything else means TLS with the system's certificate authorities |

Every call carries a deadline (`deadlineMs`, default 10 s). Create one client per process and `close()` it on shutdown; the open channel keeps a process alive.

## Usage

```ts
import {
  atLeastAsFresh,
  authzOptionsFromEnv,
  createAuthz,
  fullyConsistent,
  minimizeLatency,
  ref,
  relationship,
  touch,
} from '@auth-stack/authz';

const authz = createAuthz(authzOptionsFromEnv());

// A write-path check: fully consistent, and the token is what the write stores with the content (§7.3).
const { allowed, token } = await authz.check({
  resource: ref('document', documentId),
  permission: 'edit',
  subject: ref('user', sub),
  consistency: fullyConsistent,
});

// A content read: at least as fresh as the revision stored with the row.
await authz.check({ ...request, consistency: atLeastAsFresh(row.zedtoken) });

// A listing: the IDs of every document the user may view.
const ids = await authz.lookupResources({
  type: 'document',
  permission: 'view',
  subject: ref('user', sub),
  consistency: minimizeLatency,
});

// Several checks at one consistency, one boolean per item, in order.
const [canEdit, canShare] = await authz.bulkCheck(
  [
    { resource: doc, permission: 'edit', subject: user },
    { resource: doc, permission: 'share', subject: user },
  ],
  fullyConsistent,
);

// Relationships: `touch` is idempotent, `create` fails if present, `remove` deletes. Atomic per call.
const writtenAt = await authz.writeRelationships([
  touch(relationship(ref('project', projectId), 'organization', ref('organization', orgId))),
  touch(relationship(ref('document', documentId), 'project', ref('project', projectId))),
]);

// The relationships a filter matches, at an explicit consistency: what a write that replaces a set (a document's
// shares) reads first, fully consistent, so its deletes name what is really there.
const shares = await authz.readRelationships(
  { resourceType: 'document', resourceId: documentId, relation: 'viewer' },
  fullyConsistent,
); // [{ resource, relation, subject }]

// Bulk removal by filter: every field after the resource type narrows the set.
await authz.deleteRelationships({ resourceType: 'document', resourceId: documentId });
```

Every call names its consistency explicitly: `fullyConsistent` on the write path, `atLeastAsFresh(token)` for content reads, `minimizeLatency` for listings (`fullyConsistent` for listings until ticket 21). `check` and the write calls return the ZedToken of the revision they ran at. A check right after a schema or relationship write at `minimizeLatency` may be served from an older snapshot; pass the write's token with `atLeastAsFresh` when the result must reflect it.

`ref(type, id)` validates the object ID (SpiceDB allows `[a-zA-Z0-9/_|\-=+]`, 1 to 1024 characters, no colon) and `relationship(resource, relation, subject)` only accepts a subject of the type the schema names for that relation. `VOCABULARY` is the constant the types derive from; a unit test keeps it equal to `schema.zed`.

The `client` and `api_scope` definitions carry the client-authority workaround of `docs/README.md` §6.7; the helpers that write and resolve those grants are in `@auth-stack/client-scopes`, not here, so the workaround can be deleted as a unit.

## The schema

`schema.zed` carries `use typechecking` and a doc comment on every definition, relation, and permission. Bootstrap writes it at every start through the subpath `@auth-stack/authz/schema`:

```ts
import { ensureSchema } from '@auth-stack/authz/schema';

const { action } = await ensureSchema(authz); // 'created' | 'unchanged' | 'updated'
```

The subpath imports the `.zed` file as text, which needs a loader: bootstrap's esbuild build and the root Jest config have one; the package root does not import it, so the web apps need no bundler rule. To change the schema, edit `schema.zed` and `VOCABULARY` in `src/vocabulary.ts` together; the unit test fails until they agree.

## Checks

```sh
pnpm authz:validate         # zed validate on schema.zed, in a container (Docker, not the stack)
pnpm test packages/authz    # unit tests, no infrastructure
pnpm test:integration       # against the compose SpiceDB; reads SPICEDB_* from the environment or the root .env
pnpm authz:zed schema read  # what SpiceDB holds, through the zed CLI against the running stack
```
