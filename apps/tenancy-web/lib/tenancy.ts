/**
 * The one dependency of this app besides its session store (docs/README.md §3.1: the second client proves how
 * little a BFF needs): `tenancy-api` over HTTP, with the user's own token on every call. Env contract:
 * `TENANCY_API_URL` from bootstrap's handoff file. Built on first use and kept on `globalThis`, for the reasons
 * `lib/auth.ts` gives.
 */
import { httpTenancyClientFromEnv, type HttpTenancyClient } from '@auth-stack/tenancy/client';

const cache = globalThis as typeof globalThis & { __tenancyWebClient?: HttpTenancyClient };

export function tenancy(): HttpTenancyClient {
  cache.__tenancyWebClient ??= httpTenancyClientFromEnv();
  return cache.__tenancyWebClient;
}
