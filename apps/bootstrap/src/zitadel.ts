/**
 * The slice of Zitadel's API that bootstrap uses, as plain HTTP calls with the bootstrap machine user's PAT
 * (management API v1 for the project and the application, user API v2 for the seeded users), plus the
 * idempotent "ensure" steps on top of it. The steps take the `ZitadelApi` interface so the unit tests run them
 * against an in-memory fake; `ZitadelClient` is the real implementation.
 */

/** The OIDC settings bootstrap manages, in the JSON shape of the management API. */
export interface OidcAppConfig {
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  responseTypes: string[];
  grantTypes: string[];
  appType: string;
  authMethodType: string;
  accessTokenType: string;
  idTokenUserinfoAssertion: boolean;
  devMode: boolean;
  backChannelLogoutUri: string;
}

export interface OidcApp {
  appId: string;
  clientId: string;
  config: Partial<OidcAppConfig>;
}

/**
 * An API application (a resource server) in the project: its client ID joins the `aud` of every token the
 * project issues (docs/README.md §4.2). Private-key JWT as the auth method means no client secret exists; the
 * APIs of this stack never authenticate to Zitadel themselves in phase 1 (§6.6: calls with no user are phase 3).
 */
export interface ApiAppConfig {
  authMethodType: string;
}

export interface ApiApp {
  appId: string;
  clientId: string;
  config: Partial<ApiAppConfig>;
}

export interface NewHumanUser {
  username: string;
  email: string;
  givenName: string;
  familyName: string;
  password: string;
}

export interface ZitadelApi {
  findProjectByName(name: string): Promise<{ id: string } | undefined>;
  createProject(name: string): Promise<{ id: string }>;
  findOidcAppByName(projectId: string, name: string): Promise<OidcApp | undefined>;
  createOidcApp(projectId: string, name: string, config: OidcAppConfig): Promise<OidcApp>;
  updateOidcAppConfig(projectId: string, appId: string, config: OidcAppConfig): Promise<void>;
  findApiAppByName(projectId: string, name: string): Promise<ApiApp | undefined>;
  createApiApp(projectId: string, name: string, config: ApiAppConfig): Promise<ApiApp>;
  updateApiAppConfig(projectId: string, appId: string, config: ApiAppConfig): Promise<void>;
  findUserByUsername(username: string): Promise<{ id: string } | undefined>;
  createHumanUser(user: NewHumanUser): Promise<{ id: string }>;
}

export type EnsureAction = 'created' | 'exists' | 'updated' | 'unchanged';

export async function ensureProject(
  api: ZitadelApi,
  name: string,
): Promise<{ id: string; action: EnsureAction }> {
  const existing = await api.findProjectByName(name);
  if (existing) return { id: existing.id, action: 'exists' };
  const created = await api.createProject(name);
  return { id: created.id, action: 'created' };
}

/**
 * Find-or-create by name, then reconcile: an existing application whose settings differ from `desired` is
 * updated, so a changed URI (compose vs Tilt, a new route) takes effect on the next run without a `down -v`.
 */
export async function ensureOidcApp(
  api: ZitadelApi,
  projectId: string,
  name: string,
  desired: OidcAppConfig,
): Promise<{ appId: string; clientId: string; action: EnsureAction }> {
  const existing = await api.findOidcAppByName(projectId, name);
  if (!existing) {
    const created = await api.createOidcApp(projectId, name, desired);
    return { appId: created.appId, clientId: created.clientId, action: 'created' };
  }
  if (oidcConfigMatches(existing.config, desired)) {
    return { appId: existing.appId, clientId: existing.clientId, action: 'unchanged' };
  }
  await api.updateOidcAppConfig(projectId, existing.appId, desired);
  return { appId: existing.appId, clientId: existing.clientId, action: 'updated' };
}

/** Find-or-create by name, reconciling the auth method like `ensureOidcApp` reconciles the OIDC settings. */
export async function ensureApiApp(
  api: ZitadelApi,
  projectId: string,
  name: string,
  desired: ApiAppConfig,
): Promise<{ appId: string; clientId: string; action: EnsureAction }> {
  const existing = await api.findApiAppByName(projectId, name);
  if (!existing) {
    const created = await api.createApiApp(projectId, name, desired);
    return { appId: created.appId, clientId: created.clientId, action: 'created' };
  }
  if ((existing.config.authMethodType ?? API_AUTH_METHOD_ZERO_VALUE) === desired.authMethodType) {
    return { appId: existing.appId, clientId: existing.clientId, action: 'unchanged' };
  }
  await api.updateApiAppConfig(projectId, existing.appId, desired);
  return { appId: existing.appId, clientId: existing.clientId, action: 'updated' };
}

export async function ensureHumanUser(
  api: ZitadelApi,
  user: NewHumanUser,
): Promise<{ id: string; action: EnsureAction }> {
  const existing = await api.findUserByUsername(user.username);
  if (existing) return { id: existing.id, action: 'exists' };
  const created = await api.createHumanUser(user);
  return { id: created.id, action: 'created' };
}

// The API omits fields that hold their protobuf zero value (an unset enum, false, an empty string or list),
// so a missing field compares as that zero value rather than as "different".
const API_AUTH_METHOD_ZERO_VALUE = 'API_AUTH_METHOD_TYPE_BASIC';

const ENUM_ZERO_VALUES: Record<string, string> = {
  appType: 'OIDC_APP_TYPE_WEB',
  authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
  accessTokenType: 'OIDC_TOKEN_TYPE_BEARER',
};

export function oidcConfigMatches(actual: Partial<OidcAppConfig>, desired: OidcAppConfig): boolean {
  for (const key of Object.keys(desired) as (keyof OidcAppConfig)[]) {
    const want = desired[key];
    const have = actual[key];
    if (Array.isArray(want)) {
      const got = Array.isArray(have) ? have : [];
      if (got.length !== want.length || !want.every((item) => got.includes(item))) return false;
    } else if (typeof want === 'boolean') {
      if ((have ?? false) !== want) return false;
    } else if ((have ?? ENUM_ZERO_VALUES[key] ?? '') !== want) {
      return false;
    }
  }
  return true;
}

/** A failed call. The message carries Zitadel's error text and the request, never the token. */
export class ZitadelError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    detail: string,
  ) {
    super(`${method} ${path} failed with ${status}: ${detail}`);
    this.name = 'ZitadelError';
  }
}

const EQUALS = 'TEXT_QUERY_METHOD_EQUALS';

export class ZitadelClient implements ZitadelApi {
  constructor(
    private readonly baseUrl: string,
    private readonly pat: string,
  ) {}

  async findProjectByName(name: string): Promise<{ id: string } | undefined> {
    const body = await this.call<{ result?: { id: string }[] }>(
      'POST',
      '/management/v1/projects/_search',
      { queries: [{ nameQuery: { name, method: EQUALS } }] },
    );
    return body.result?.[0];
  }

  createProject(name: string): Promise<{ id: string }> {
    return this.call<{ id: string }>('POST', '/management/v1/projects', { name });
  }

  async findOidcAppByName(projectId: string, name: string): Promise<OidcApp | undefined> {
    const body = await this.call<{
      result?: { id: string; oidcConfig?: Partial<OidcAppConfig> & { clientId: string } }[];
    }>('POST', `/management/v1/projects/${projectId}/apps/_search`, {
      queries: [{ nameQuery: { name, method: EQUALS } }],
    });
    const app = body.result?.[0];
    if (!app?.oidcConfig) return undefined;
    const { clientId, ...config } = app.oidcConfig;
    return { appId: app.id, clientId, config };
  }

  async createOidcApp(projectId: string, name: string, config: OidcAppConfig): Promise<OidcApp> {
    const body = await this.call<{ appId: string; clientId: string }>(
      'POST',
      `/management/v1/projects/${projectId}/apps/oidc`,
      { name, ...config },
    );
    return { appId: body.appId, clientId: body.clientId, config };
  }

  async updateOidcAppConfig(
    projectId: string,
    appId: string,
    config: OidcAppConfig,
  ): Promise<void> {
    await this.call(
      'PUT',
      `/management/v1/projects/${projectId}/apps/${appId}/oidc_config`,
      config,
    );
  }

  async findApiAppByName(projectId: string, name: string): Promise<ApiApp | undefined> {
    const body = await this.call<{
      result?: { id: string; apiConfig?: Partial<ApiAppConfig> & { clientId: string } }[];
    }>('POST', `/management/v1/projects/${projectId}/apps/_search`, {
      queries: [{ nameQuery: { name, method: EQUALS } }],
    });
    const app = body.result?.[0];
    if (!app?.apiConfig) return undefined;
    const { clientId, ...config } = app.apiConfig;
    return { appId: app.id, clientId, config };
  }

  async createApiApp(projectId: string, name: string, config: ApiAppConfig): Promise<ApiApp> {
    // The response carries a client secret only for the basic auth method, which this stack never requests.
    const body = await this.call<{ appId: string; clientId: string }>(
      'POST',
      `/management/v1/projects/${projectId}/apps/api`,
      { name, ...config },
    );
    return { appId: body.appId, clientId: body.clientId, config };
  }

  async updateApiAppConfig(projectId: string, appId: string, config: ApiAppConfig): Promise<void> {
    await this.call('PUT', `/management/v1/projects/${projectId}/apps/${appId}/api_config`, config);
  }

  async findUserByUsername(username: string): Promise<{ id: string } | undefined> {
    const body = await this.call<{ result?: { userId: string }[] }>('POST', '/v2/users', {
      queries: [{ userNameQuery: { userName: username, method: EQUALS } }],
    });
    const user = body.result?.[0];
    return user ? { id: user.userId } : undefined;
  }

  async createHumanUser(user: NewHumanUser): Promise<{ id: string }> {
    const body = await this.call<{ userId: string }>('POST', '/v2/users/human', {
      username: user.username,
      profile: { givenName: user.givenName, familyName: user.familyName },
      // Verified at creation, so logging in needs no Mailpit round trip (docs/README.md §6.3).
      email: { email: user.email, isVerified: true },
      password: { password: user.password, changeRequired: false },
    });
    return { id: body.userId };
  }

  private async call<T>(method: string, path: string, payload: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.pat}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ZitadelError(response.status, method, path, errorDetail(text));
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: string };
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return text.slice(0, 300);
}

/** Polls Zitadel's readiness endpoint until it answers, for runs that start before `--wait` would. */
export async function waitForZitadel(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/debug/ready`);
      if (response.ok) return;
    } catch {
      // Not reachable yet.
    }
    if (Date.now() >= deadline)
      throw new Error(`Zitadel at ${baseUrl} not ready after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

export interface Discovery {
  issuer: string;
  jwks_uri: string;
  userinfo_endpoint: string;
}

export async function fetchDiscovery(baseUrl: string): Promise<Discovery> {
  const response = await fetch(`${baseUrl}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`discovery at ${baseUrl} failed with ${response.status}`);
  return (await response.json()) as Discovery;
}
