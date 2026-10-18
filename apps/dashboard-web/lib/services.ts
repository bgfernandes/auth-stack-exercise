/**
 * The phase 1 arrangement (docs/README.md §6.5): the documents domain runs in this process, over its own
 * database and SpiceDB, and tenancy is reached over HTTP. Env contract: `DOCUMENTS_DATABASE_URL`, `SPICEDB_*`
 * (`@auth-stack/authz`) from the compose service or the Tiltfile, `TENANCY_API_URL` from bootstrap's handoff
 * file. Built on first use and kept on `globalThis`, for the reasons `lib/auth.ts` gives; nothing connects
 * until the first query. Phase 2 replaces this with HTTP calls to `dashboard-api` and drops the connections.
 */
import { authzOptionsFromEnv, createAuthz } from '@auth-stack/authz';
import { createDb } from '@auth-stack/db-core';
import { createDocumentsService, schema, type DocumentsService } from '@auth-stack/documents';
import { httpTenancyClientFromEnv, type TenancyClient } from '@auth-stack/tenancy/client';

export interface Services {
  tenancy: TenancyClient;
  documents: DocumentsService;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

function build(): Services {
  const tenancy = httpTenancyClientFromEnv();
  const authz = createAuthz(authzOptionsFromEnv());
  const db = createDb(required('DOCUMENTS_DATABASE_URL'), schema);
  return { tenancy, documents: createDocumentsService({ db, authz, tenancy }) };
}

const cache = globalThis as typeof globalThis & { __dashboardWebServices?: Services };

export function services(): Services {
  cache.__dashboardWebServices ??= build();
  return cache.__dashboardWebServices;
}
