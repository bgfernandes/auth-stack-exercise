// drizzle-kit: `pnpm db:generate` diffs src/schema.ts against the snapshots in migrations/ and writes the next
// SQL file; `pnpm db:migrate` applies the folder to the database. Bootstrap applies the same folder through
// @auth-stack/db-core; both record what ran in drizzle.__drizzle_migrations.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    // The development default of docker/postgres/init.sql, reached from the host; compose and Tilt set the variable.
    url:
      process.env.DOCUMENTS_DATABASE_URL ??
      'postgres://documents:documents@localhost:5432/documents',
  },
  strict: true,
  verbose: true,
});
