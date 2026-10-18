/**
 * The process: wires the tenancy service (its database and SpiceDB), the bearer verifier of `apis.env`, the
 * SpiceDB-backed scope resolver, and the userinfo client into the Fastify app, and listens on `PORT` (4001).
 * Env contract: `TENANCY_DATABASE_URL`, `SPICEDB_*` (`@auth-stack/authz`), `OIDC_ISSUER`, `OIDC_PROJECT_ID`,
 * `OIDC_JWKS_URL`, `OIDC_USERINFO_URL` (bootstrap's `apis.env`), optional `PORT`, `HOST`, `LOG_LEVEL`.
 */
import { bearerOptionsFromEnv, createBearerVerifier } from '@auth-stack/auth';
import { authzOptionsFromEnv, createAuthz } from '@auth-stack/authz';
import { createScopeResolver } from '@auth-stack/client-scopes';
import { closeDb, createDb } from '@auth-stack/db-core';
import { createTenancyService, schema } from '@auth-stack/tenancy';

import { buildApp } from './app';
import { createUserinfoClient } from './userinfo';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

const port = Number(process.env.PORT ?? 4001);
const host = process.env.HOST ?? '0.0.0.0';

const authz = createAuthz(authzOptionsFromEnv());
const db = createDb(required('TENANCY_DATABASE_URL'), schema);
const app = await buildApp({
  service: createTenancyService({ db, authz }),
  verifier: createBearerVerifier(bearerOptionsFromEnv()),
  scopes: createScopeResolver(authz),
  userinfo: createUserinfoClient({ url: required('OIDC_USERINFO_URL') }),
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
