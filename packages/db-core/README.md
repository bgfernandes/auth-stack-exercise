# `@auth-stack/db-core`

The Postgres connection factory and the migration runner, and no tables ([`docs/README.md`](../../docs/README.md) §3.1: platform packages carry no domain tables). Drizzle over postgres-js. Each service package (`tenancy`, `documents`, later `comments`) passes its own schema to `createDb`, owns its migrations folder, and bootstrap applies every folder before the apps start.

## Usage

```ts
import { closeDb, createDb, runMigrations } from '@auth-stack/db-core';
import { schema } from '@auth-stack/tenancy';

const db = createDb(process.env.TENANCY_DATABASE_URL, schema); // typed with the package's tables
await runMigrations(db, '/path/to/packages/tenancy/migrations'); // a no-op when nothing is pending
const rows = await db.select().from(schema.users);
await closeDb(db); // ends the pool; an open pool keeps the process alive
```

`createDb(connectionString, schema, { max })` opens a pool (`max` connections, default 10; bootstrap uses 1) and connects on the first query. The connection strings are `postgres://<role>:<password>@<host>:5432/<database>`; the development values are in the root `.env` (`TENANCY_DATABASE_URL`, `DOCUMENTS_DATABASE_URL`, host `postgres` inside compose, `localhost` from the host).

Inside a transaction, use the transaction handle for every query: a query that goes through the pool from inside `db.transaction` waits for a second connection, and concurrent transactions that all do so wait for each other.

## Migrations

A package keeps a `drizzle.config.ts` pointing at `src/schema.ts` and `./migrations`, and two scripts:

```sh
pnpm --filter @auth-stack/tenancy db:generate --name <change>   # diff the schema, write the next SQL file
pnpm --filter @auth-stack/tenancy db:migrate                     # apply to the database in <PACKAGE>_DATABASE_URL
pnpm db:migrate                                                  # every package, against the running stack
```

`runMigrations` and `drizzle-kit migrate` read the same folder (`meta/_journal.json` lists the files) and record what ran in `drizzle.__drizzle_migrations`, so either can follow the other. Commit the SQL files and the `meta/` folder; Prettier ignores `meta/`. In compose, bootstrap's image carries each package's folder next to its bundle and applies them at every start.

## Testing

`@auth-stack/db-core/testing` gives an integration test a database of its own on the compose Postgres:

```ts
import { adminUrlFromEnv, createTestDatabase } from '@auth-stack/db-core/testing';

const database = await createTestDatabase({
  adminUrl: adminUrlFromEnv(), // POSTGRES_ADMIN_USER, POSTGRES_ADMIN_PASSWORD, POSTGRES_HOST (localhost)
  name: 'it_tenancy', // one fixed name per test file
  schema,
  migrationsFolder: new URL('../migrations', import.meta.url).pathname,
});
// database.db, database.url; database.drop() in afterAll
```

The database is dropped (`WITH (FORCE)`) before it is created, so a crashed run leaves at most one database of that name for the next run to replace, then migrated from zero, which is what proves the migrations apply on a fresh database.

SpiceDB has no equivalent unit, so integration tests share the compose instance and isolate by data: fresh UUIDs for resources, a per-run suffix on subjects, and the relationships they wrote removed in `afterAll`.

## Checks

```sh
pnpm test packages/db-core   # nothing yet: the runner is exercised by the tenancy and documents integration tests
pnpm test:integration        # against the compose stack
```
