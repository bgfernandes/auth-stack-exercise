/**
 * The process: wires the documents service (its database, SpiceDB, and tenancy over HTTP), the bearer verifier
 * of `apis.env`, and the SpiceDB-backed scope resolver into the Fastify app, and listens on `PORT` (4002).
 * Env contract: `DOCUMENTS_DATABASE_URL`, `SPICEDB_*` (`@auth-stack/authz`), `TENANCY_API_URL`
 * (`@auth-stack/tenancy/client`), `OIDC_ISSUER`, `OIDC_PROJECT_ID`, `OIDC_JWKS_URL` (bootstrap's `apis.env`),
 * optional `PORT`, `HOST`, `LOG_LEVEL`.
 */
import { bearerOptionsFromEnv, createBearerVerifier } from '@auth-stack/auth';
import { authzOptionsFromEnv, createAuthz } from '@auth-stack/authz';
import { createScopeResolver } from '@auth-stack/client-scopes';
import { closeDb, createDb } from '@auth-stack/db-core';
import { createDocumentsService, schema } from '@auth-stack/documents';
import { httpTenancyClientFromEnv } from '@auth-stack/tenancy/client';

import { buildApp } from './app';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

const port = Number(process.env.PORT ?? 4002);
const host = process.env.HOST ?? '0.0.0.0';

const authz = createAuthz(authzOptionsFromEnv());
const db = createDb(required('DOCUMENTS_DATABASE_URL'), schema);
const app = await buildApp({
  service: createDocumentsService({ db, authz, tenancy: httpTenancyClientFromEnv() }),
  verifier: createBearerVerifier(bearerOptionsFromEnv()),
  scopes: createScopeResolver(authz),
  ...(process.env.LOG_LEVEL ? { logLevel: process.env.LOG_LEVEL } : {}),
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await closeDb(db);
  authz.close();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    });
  });
}

await app.listen({ port, host });
