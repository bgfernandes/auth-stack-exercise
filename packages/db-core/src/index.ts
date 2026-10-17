/**
 * `@auth-stack/db-core`: the Postgres connection factory and the migration runner, and nothing else
 * (docs/README.md §3.1: platform packages carry no domain tables). Each service package passes its own Drizzle
 * schema to `createDb` and keeps its migrations in its own folder; bootstrap runs them all (§3.1, one bend).
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';

/** A Drizzle database over postgres-js, typed with the owning package's schema. */
export type Db<TSchema extends Record<string, unknown> = Record<string, never>> =
  PostgresJsDatabase<TSchema> & { $client: Sql };

export interface DbOptions {
  /** Connections in the pool; one is enough for a one-shot like bootstrap, the APIs keep the default. */
  max?: number;
}

/**
 * Opens a pool on the connection string (`postgres://role:password@host:5432/database`) and wraps it in
 * Drizzle. Nothing connects until the first query; `closeDb` ends the pool.
 */
export function createDb<TSchema extends Record<string, unknown>>(
  connectionString: string,
  schema: TSchema,
  options: DbOptions = {},
): Db<TSchema> {
  const client = postgres(connectionString, { max: options.max ?? 10 });
  return drizzle(client, { schema });
}

/** Ends the pool; a process that does not is kept alive by it. */
export async function closeDb(db: Db<Record<string, unknown>>): Promise<void> {
  await db.$client.end();
}

/**
 * Applies the migrations drizzle-kit generated into `folder` (its `meta/_journal.json` lists them) that the
 * database has not seen, recorded in the `drizzle.__drizzle_migrations` table; a no-op when none is pending.
 * `drizzle-kit migrate` (the packages' `db:migrate` scripts) keeps the same journal and table.
 */
export async function runMigrations(
  db: Db<Record<string, unknown>>,
  folder: string,
): Promise<void> {
  await migrate(db, { migrationsFolder: folder });
}
