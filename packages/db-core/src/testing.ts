/**
 * `@auth-stack/db-core/testing`: a database that a test file owns outright, on the compose Postgres (the
 * integration project of Jest). It is dropped before it is created, so a crashed run leaves at most one database
 * of that name for the next run to replace, then migrated from zero, which is what proves the migrations apply
 * on a fresh database; `drop()` removes it again.
 */
import postgres from 'postgres';

import { createDb, runMigrations, type Db } from './index.js';

export interface TestDatabaseOptions<TSchema extends Record<string, unknown>> {
  /** A superuser connection, to create and drop databases: the stack's admin role (`.env`). */
  adminUrl: string;
  /** `it_<package>`: lowercase letters, digits, and underscores; one per test file. */
  name: string;
  schema: TSchema;
  migrationsFolder: string;
}

export interface TestDatabase<TSchema extends Record<string, unknown>> {
  db: Db<TSchema>;
  /** The connection string of the database itself. */
  url: string;
  /** Closes the pool and drops the database. */
  drop(): Promise<void>;
}

const NAME = /^[a-z_][a-z0-9_]*$/;

/** `postgres://<user>:<password>@<host>:5432/postgres` from `POSTGRES_ADMIN_USER`, `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_HOST`. */
export function adminUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const user = env.POSTGRES_ADMIN_USER;
  const password = env.POSTGRES_ADMIN_PASSWORD;
  if (!user || !password) {
    throw new Error(
      'missing environment variables POSTGRES_ADMIN_USER and POSTGRES_ADMIN_PASSWORD',
    );
  }
  const host = env.POSTGRES_HOST ?? 'localhost';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:5432/postgres`;
}

export async function createTestDatabase<TSchema extends Record<string, unknown>>(
  options: TestDatabaseOptions<TSchema>,
): Promise<TestDatabase<TSchema>> {
  const { adminUrl, name, schema, migrationsFolder } = options;
  if (!NAME.test(name)) throw new Error(`invalid test database name: ${JSON.stringify(name)}`);
  await dropDatabase(adminUrl, name);
  await asAdmin(adminUrl, (admin) => admin.unsafe(`CREATE DATABASE "${name}"`));
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = createDb(url.toString(), schema, { max: 4 });
  await runMigrations(db, migrationsFolder);
  return {
    db,
    url: url.toString(),
    async drop() {
      // A bounded wait: a test that wedged the pool must not also wedge the teardown.
      await db.$client.end({ timeout: 5 });
      await dropDatabase(adminUrl, name);
    },
  };
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  // FORCE (Postgres 13+) terminates sessions still attached, such as a pool a crashed run never closed.
  await asAdmin(adminUrl, (admin) =>
    admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
  );
}

async function asAdmin(
  adminUrl: string,
  run: (admin: postgres.Sql) => Promise<unknown>,
): Promise<void> {
  // DROP DATABASE IF EXISTS raises a NOTICE when there is nothing to drop; the default handler prints it.
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await run(admin);
  } finally {
    await admin.end();
  }
}
