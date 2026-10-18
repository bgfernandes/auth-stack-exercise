# `@auth-stack/documents`

The documents domain as a package ([`docs/README.md`](../../docs/README.md) §3.1, §5.2): projects under a tenancy organization and the documents whose two values the dashboard edits. Roles and shares live in SpiceDB; every document row carries the ZedToken of the check its last content write or share ran under (§7.3). The package root (schema, migrations, the service) is imported by `dashboard-api` ([`apps/dashboard-api`](../../apps/dashboard-api)) alone, plus bootstrap for the migrations and the seed; what a caller of that API needs, the HTTP client included, is on the subpath `@auth-stack/documents/client`, which is what a BFF imports.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DOCUMENTS_DATABASE_URL` | `postgres://documents:documents@postgres:5432/documents` in compose; `localhost` from the host (`.env`) |
| `SPICEDB_*` | The SpiceDB connection of [`@auth-stack/authz`](../authz/README.md), which the service checks before every read and write |
| `DASHBOARD_API_URL` | Where the HTTP client of the subpath reaches `dashboard-api`: `http://dashboard-api:4002` in compose, `http://localhost:4002` under Tilt; bootstrap writes it to each BFF's env file |

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

// Share (§6.8, §7.3): replaces the document's direct shares with this set; `share` fully consistent, member IDs only.
const shared = await documents.setDocumentShares(user, id, { editors: [bobSub], viewers: [] }); // stores the write's token
```

`user` is the `UserContext` of the tenancy client (`{ sub, accessToken }`). A method that may not proceed throws `DocumentsError` with a `code`: `forbidden` when the user may view the document but not edit or share it (`403`), `not_found` when the document does not exist (a malformed ID included) or the user may not learn that it does (`404`), `not_a_member` when a share names a user who is not a member of the organization that owns the document (`400`; the IDs are Zitadel `sub`s, checked as `organization#view`, so an unknown account and a known non-member answer alike). Invalid input throws a `ZodError` (`value1` and `value2`: strings of 1 to 200 characters; `editors` and `viewers`: up to a hundred IDs each, no ID twice). Test for the error with `isDocumentsError(error)` rather than `instanceof`: a bundler can give a Next.js route handler and a server component separate copies of the package while the service they share was built by one of them.

`setDocumentShares` reads the direct shares on the document fully consistent, writes the difference (TOUCH for every listed user, DELETE for every other) in one atomic call, and stores the write's token on the row without touching its values or writer; two concurrent replacements race and the later write wins whole. An unchanged set writes nothing and stores the check's token.

`ensurePersonalProject` checks `organization#create_project` at full consistency, inserts the "Personal" project behind a partial unique index on `(organization_id) WHERE is_personal`, writes the project and document relationships with TOUCH, and inserts the "Welcome" document with the write's token, in one transaction. A grant made outside the service (a share, a seed) stores its token on the affected rows for the same reason: a read checks at least as fresh as the row, so a newer grant may otherwise stay invisible to it for one window.

## The API's client, wire format, and scopes

```ts
import {
  documentValuesSchema,
  httpDocumentsClientFromEnv,
  isDocumentsClientError,
  type DocumentsClient,
  type DocumentSummary,
  type VisibleDocument,
} from '@auth-stack/documents/client';

const documents = httpDocumentsClientFromEnv(); // DASHBOARD_API_URL; or createHttpDocumentsClient({ baseUrl, fetch })

// The same five calls as the service, as the user, over HTTP; the API picks the listing's consistency.
const rows = await documents.listVisibleDocuments(user);
const row = await documents.getDocumentForEdit(user, id);
const values = documentValuesSchema.parse({ value1, value2 }); // the BFF checks the rule before calling
const updated = await documents.updateDocument(user, id, values);
const shared = await documents.setDocumentShares(user, id, { editors: [bobSub], viewers: [] });
const { project, document, created } = await documents.ensurePersonalProject(user, organizationId);
```

The subpath carries no schema and no database, so a BFF imports it alone. `DocumentsClient` is the interface; `createHttpDocumentsClient` sends every call with the user's access token as a bearer token, parses the answers with the wire schemas below, and caches nothing, since every answer is a permission decision for one user at one moment. An answer outside the contract throws `DocumentsClientError` with the `status` and the API's `code` (`forbidden`, `not_found`, `not_a_member`, `invalid_input`, the bearer plugin's `invalid_token` and `insufficient_scope`, or `http_error` for a body that is not the API's, such as a proxy's page); test for it with `isDocumentsClientError(error)` rather than `instanceof`, for the reason given above. `documentValuesSchema` lives here too, so a BFF validates the edit form with the same rule the service enforces, without importing the package root. The wire format is snake_case JSON with dates as ISO strings, defined once and used by `dashboard-api` to answer and by a client to parse: a document is `{ "id", "project_id", "organization_id", "name", "value_1", "value_2", "updated_at", "updated_by" }` (never the row's `zedtoken`); `GET /documents` answers `{ "documents": [{ "id", "name", "project": { "id", "name" }, "organization": { "id", "name" }, "can_edit", "updated_at" }] }` with `organization.name` null when tenancy does not show the organization to the user; `POST /organizations/:id/personal-project` answers `{ "project": { "id", "organization_id", "name", "is_personal", "created_at" }, "document", "created" }`. The request bodies are `{ "value_1", "value_2" }` for `PUT /documents/:id` and `{ "editors": [...], "viewers": [...] }` for `PUT /documents/:id/shares`; their schemas (`documentValuesWire`, `documentSharesWire`) check the shape only, the service owns the constraints. `DOCUMENTS_API_SCOPES` (`documents:read`, `documents:write`) names what the routes require and what bootstrap grants to each first-party client (§6.7). `VisibleDocument`, the dashboard row type, is defined here and re-exported by the package root.

## Seeding

```ts
import { seedDocuments } from '@auth-stack/documents';

const { createdProjects, createdDocuments, token } = await seedDocuments(
  { db, authz },
  {
    organizationId, // seeded by packages/tenancy first, so its roles are older than this write
    createdBy: aliceSub, // recorded as `updated_by` on the documents this run creates
    projects: [{ id: marketingId, name: 'Marketing', roles: [{ sub: bobSub, role: 'editor' }] }],
    documents: [
      { id: launchPlanId, projectId: marketingId, name: 'Launch plan', value1: 'Q1', value2: 'Draft', roles: [{ sub: carolSub, role: 'editor' }] },
    ],
  },
);
```

For bootstrap (`docs/README.md` §6.3), which is trusted and has no principal to check. The IDs are fixed UUIDs the caller chooses, so reruns match the same rows and a test seeds a scenario of its own under random ones. In one transaction: the projects and documents are created if absent, and an existing document keeps its values and its writer; every relationship (`project#organization`, `document#project`, the project roles `owner`, `editor`, `viewer`, the direct document shares `editor`, `viewer`) is TOUCHed on every run; and the write's token replaces `zedtoken` on every seeded document, so a share removed by hand, or a `sub` that changed with a reset IdP, is repaired by the next run and the edit page's read, at least as fresh as the row, sees it (§7.3). A document naming a project the seed does not is refused before anything is written.

## Schema and migrations

`src/schema.ts` defines `projects` and `documents`; `migrations/` holds what `pnpm db:generate --name <change>` produced from it, applied by `pnpm db:migrate` on the host and by bootstrap in compose ([`@auth-stack/db-core`](../db-core/README.md)). Change the schema and generate in the same commit.

## Checks

```sh
pnpm test packages/documents   # unit tests: the values and shares schemas, the wire format, the HTTP client over a stub API (apps/dashboard-api's own test runs it over the real routes)
pnpm test:integration          # against the compose stack: its own database it_documents, migrated from zero; the service (shares included) and the seed, which asserts the §6.3 table; dashboard-api's own test runs the routes over the service on it_dashboard_api
```
