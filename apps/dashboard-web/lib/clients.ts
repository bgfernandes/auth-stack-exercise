/**
 * The two APIs this BFF calls (docs/README.md §6.5, from ticket 19): `dashboard-api` for every documents
 * operation and `tenancy-api` for the provisioning call of the login, each over HTTP with the user's own
 * access token on every call. Env contract: `DASHBOARD_API_URL` and `TENANCY_API_URL` from bootstrap's handoff
 * file. Built on first use and kept on `globalThis`, for the reasons `lib/auth.ts` gives. Nothing here connects
 * to a database or to SpiceDB: the API is the one place that checks them for documents.
 */
import { httpDocumentsClientFromEnv, type DocumentsClient } from '@auth-stack/documents/client';
import { httpTenancyClientFromEnv, type TenancyClient } from '@auth-stack/tenancy/client';

export interface Clients {
  documents: DocumentsClient;
  tenancy: TenancyClient;
}

const cache = globalThis as typeof globalThis & { __dashboardWebClients?: Clients };

export function clients(): Clients {
  cache.__dashboardWebClients ??= {
    documents: httpDocumentsClientFromEnv(),
    tenancy: httpTenancyClientFromEnv(),
  };
  return cache.__dashboardWebClients;
}
