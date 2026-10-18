/**
 * `TenancyClient` over HTTP to `tenancy-api` (docs/README.md §6.6): every call carries the user's own access
 * token, and `getOrganization` answers, found or not, are reused per user and organization for a minute,
 * because a BFF asks on every render and organization data changes rarely. The cache is keyed by the user as
 * well as the organization: an answer is a permission decision for that user, and reusing it for another would
 * tell a non-member what a member sees.
 */
import { fromWire, organizationsWire, organizationWire, provisionWire } from './wire';

import type { OrganizationSummary, ProvisionResult, TenancyClient, UserContext } from './index';

export interface HttpTenancyClientOptions {
  /** `http://tenancy-api:4001` in compose, `http://localhost:4001` under Tilt (`TENANCY_API_URL`). */
  baseUrl: string;
  fetch?: typeof fetch;
  /** How long a `getOrganization` answer is reused per user and organization; 60 s by default. */
  cacheTtlMs?: number;
  now?: () => number;
}

/** An answer other than the ones the contract allows: the status and the API's error code. */
export class TenancyClientError extends Error {
  override readonly name = 'TenancyClientError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpTenancyClient extends TenancyClient {
  /** Drops the cached organization answers of one user, or of everyone. */
  invalidate(sub?: string): void;
}

interface CacheEntry {
  value: OrganizationSummary | undefined;
  expiresAt: number;
}

export function createHttpTenancyClient(options: HttpTenancyClientOptions): HttpTenancyClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const ttlMs = options.cacheTtlMs ?? 60_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<OrganizationSummary | undefined>>();
  const keyOf = (sub: string, id: string) => `${sub}\u0000${id}`;

  async function call(
    user: UserContext,
    method: 'GET' | 'POST',
    path: string,
    accepted: number[],
  ): Promise<{ status: number; body: unknown }> {
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${user.accessToken}`, accept: 'application/json' },
    });
    const text = await response.text();
    // A body that is not JSON (a proxy's error page) is reported through the status, not as a parse error.
    const body: unknown = text ? parseJson(text) : undefined;
    if (!accepted.includes(response.status)) {
      const code =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : 'http_error';
      throw new TenancyClientError(
        response.status,
        code,
        `${method} ${path}: ${response.status} ${code}`,
      );
    }
    return { status: response.status, body };
  }

  async function fetchOrganization(
    user: UserContext,
    id: string,
  ): Promise<OrganizationSummary | undefined> {
    const { status, body } = await call(
      user,
      'GET',
      `/organizations/${encodeURIComponent(id)}`,
      [200, 404],
    );
    return status === 404 ? undefined : fromWire(organizationWire.parse(body));
  }

  return {
    async provisionUser(user): Promise<ProvisionResult> {
      const { body } = await call(user, 'POST', '/me/provision', [200]);
      const parsed = provisionWire.parse(body);
      // The personal organization is now known for this user; whatever was cached for it is stale.
      cache.set(keyOf(user.sub, parsed.organization.id), {
        value: fromWire(parsed.organization),
        expiresAt: now() + ttlMs,
      });
      return { organization: fromWire(parsed.organization), created: parsed.created };
    },

    getOrganization(user, id) {
      const key = keyOf(user.sub, id);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value);
      let inFlight = pending.get(key);
      if (!inFlight) {
        inFlight = fetchOrganization(user, id)
          .then((value) => {
            cache.set(key, { value, expiresAt: now() + ttlMs });
            return value;
          })
          .finally(() => pending.delete(key));
        pending.set(key, inFlight);
      }
      return inFlight;
    },

    async listOrganizations(user) {
      const { body } = await call(user, 'GET', '/me/organizations', [200]);
      return organizationsWire.parse(body).organizations.map(fromWire);
    },

    invalidate(sub) {
      if (sub === undefined) {
        cache.clear();
        return;
      }
      for (const key of cache.keys()) if (key.startsWith(`${sub}\u0000`)) cache.delete(key);
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The client of `TENANCY_API_URL`, the value bootstrap writes to each BFF's env file. */
export function httpTenancyClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<HttpTenancyClientOptions, 'baseUrl'> = {},
): HttpTenancyClient {
  const baseUrl = env.TENANCY_API_URL;
  if (!baseUrl) throw new Error('missing environment variable TENANCY_API_URL');
  return createHttpTenancyClient({ baseUrl, ...options });
}
