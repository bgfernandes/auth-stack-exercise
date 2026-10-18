/**
 * The one documents call this app makes (docs/README.md §6.4): the personal workspace of a user logging in here
 * for the first time, through `dashboard-api` with the user's own token, so that a user who never opens
 * `dashboard-web` has a workspace all the same. Env contract: `DASHBOARD_API_URL` from bootstrap's handoff
 * file. Built on first use and kept on `globalThis`, for the reasons `lib/auth.ts` gives.
 */
import { httpDocumentsClientFromEnv, type DocumentsClient } from '@auth-stack/documents/client';

const cache = globalThis as typeof globalThis & { __tenancyWebDocumentsClient?: DocumentsClient };

export function documents(): DocumentsClient {
  cache.__tenancyWebDocumentsClient ??= httpDocumentsClientFromEnv();
  return cache.__tenancyWebDocumentsClient;
}
