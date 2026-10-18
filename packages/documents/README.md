# `@auth-stack/documents`

The documents domain as a package ([`docs/README.md`](../../docs/README.md) §3.1, §5.2): projects under a tenancy organization and the documents whose two values the dashboard edits. Roles and shares live in SpiceDB; every document row carries the ZedToken of the check its last content write ran under (§7.3). Imported by `dashboard-web` in phase 1 and only by `dashboard-api` from phase 2.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DOCUMENTS_DATABASE_URL` | `postgres://documents:documents@postgres:5432/documents` in compose; `localhost` from the host (`.env`) |
| `SPICEDB_*` | The SpiceDB connection of [`@auth-stack/authz`](../authz/README.md), which the service checks before every read and write |

The service also needs a `TenancyClient` ([`@auth-stack/tenancy/client`](../tenancy/README.md)) for organization names.

## Usage

```ts
import { authzOptionsFromEnv, createAuthz, fullyConsistent } from '@auth-stack/authz';
import { createDb } from '@auth-stack/db-core';
import { createDocumentsService, DocumentsError, schema } from '@auth-stack/documents';

const db = createDb(process.env.DOCUMENTS_DATABASE_URL, schema);
const documents = createDocumentsService({ db, authz: createAuthz(authzOptionsFromEnv()), tenancy });

// Login callback (§6.4), after tenancy provisioned the personal organization: idempotent, race-safe.
const { project, document, created } = await documents.ensurePersonalProject(user, organizationId);

// Dashboard (§6.5): one lookup of `view`, one bulk check of `edit`; phase 1 lists at full consistency.
const rows = await documents.listVisibleDocuments(user, fullyConsistent); // { id, name, project, organization, canEdit }

// Edit form and save (§6.5, §7.3): `edit` at least as fresh as the row's token to read, fully consistent to write.
const row = await documents.getDocumentForEdit(user, id);
const updated = await documents.updateDocument(user, id, { value1, value2 }); // stores the check's token with the values
```

`user` is the `UserContext` of the tenancy client (`{ sub, accessToken }`). A method that may not proceed throws `DocumentsError` with a `code`: `forbidden` when the user may view the document but not edit it (`403`), `not_found` when the document does not exist (a malformed ID included) or the user may not learn that it does (`404`). Invalid values throw a `ZodError` (`value1` and `value2`: strings of 1 to 200 characters). Test for the error with `isDocumentsError(error)` rather than `instanceof`: a bundler can give a Next.js route handler and a server component separate copies of the package while the service they share was built by one of them.

`ensurePersonalProject` checks `organization#create_project` at full consistency, inserts the "Personal" project behind a partial unique index on `(organization_id) WHERE is_personal`, writes the project and document relationships with TOUCH, and inserts the "Welcome" document with the write's token, in one transaction. A grant made outside the service (a share, a seed) stores its token on the affected rows for the same reason: a read checks at least as fresh as the row, so a newer grant may otherwise stay invisible to it for one window.

## Schema and migrations

`src/schema.ts` defines `projects` and `documents`; `migrations/` holds what `pnpm db:generate --name <change>` produced from it, applied by `pnpm db:migrate` on the host and by bootstrap in compose ([`@auth-stack/db-core`](../db-core/README.md)). Change the schema and generate in the same commit.

## Checks

```sh
pnpm test packages/documents   # unit tests: the values schema
pnpm test:integration          # against the compose stack: its own database it_documents, migrated from zero
```
