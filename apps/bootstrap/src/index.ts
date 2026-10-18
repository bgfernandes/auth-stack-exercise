/**
 * Bootstrap (ticket 4): a one-shot, idempotent configuration of the stack. It writes the SpiceDB schema
 * (ticket 6), runs the service packages' database migrations (ticket 7), creates the single Zitadel project,
 * the dashboard-web application, and the tenancy-api API application, grants the first-party clients the
 * scopes of the APIs they call (§6.7, ticket 16), seeds the users of docs/README.md §6.3, and writes the
 * handoff files the apps start from. Every object is matched by name first and every migration is recorded, so running it again
 * creates nothing. Any failure exits non-zero so compose surfaces it and the apps that depend on it never start.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  authzOptionsFromEnv,
  createAuthz,
  relationship,
  touch,
  type Authz,
} from '@auth-stack/authz';
import { ensureSchema } from '@auth-stack/authz/schema';
import { apiScope, client } from '@auth-stack/client-scopes';
import { closeDb, createDb, runMigrations } from '@auth-stack/db-core';
import { TENANCY_API_SCOPES } from '@auth-stack/tenancy';

import { writeHandoff, type Handoff } from './handoff';
import { log, logError } from './log';
import { SEED_USERS } from './seed';
import {
  ensureApiApp,
  ensureHumanUser,
  ensureOidcApp,
  ensureProject,
  fetchDiscovery,
  waitForZitadel,
  ZitadelClient,
  type ApiAppConfig,
  type OidcAppConfig,
} from './zitadel';

const PROJECT_NAME = 'auth-stack-exercise';
const DASHBOARD_WEB_APP = 'dashboard-web';
const TENANCY_API_APP = 'tenancy-api';
const READY_TIMEOUT_MS = 120_000;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Web application, PKCE without a secret, JWT access tokens, userinfo claims in the ID token (§4.2, §4.4). */
export function dashboardWebConfig(publicUrl: string): OidcAppConfig {
  return {
    redirectUris: [`${publicUrl}/auth/callback`],
    postLogoutRedirectUris: [`${publicUrl}/`],
    responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
    grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', 'OIDC_GRANT_TYPE_REFRESH_TOKEN'],
    appType: 'OIDC_APP_TYPE_WEB',
    authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
    accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
    idTokenUserinfoAssertion: true,
    // Allows an http:// redirect URI on a host other than localhost (ticket 3); off behind TLS.
    devMode: true,
    // Zitadel calls this URL server to server (§4.4 step 6; the route arrives in ticket 18). It is the public
    // URL: Zitadel resolves the hostname at registration time, and the app's service name is not in DNS until
    // the app starts, which happens after bootstrap. zitadel-api maps the hostname to the host gateway.
    backChannelLogoutUri: `${publicUrl}/auth/backchannel-logout`,
  };
}

/** A resource server: no secret, no key (§6.6: the APIs hold no identity of their own in phase 1). */
export const API_APP_CONFIG: ApiAppConfig = {
  authMethodType: 'API_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT',
};

/**
 * Client authority (docs/README.md §6.7): every first-party client is granted every scope of every API it calls,
 * as `api_scope:<scope>#grantee@client:<client_id>` with TOUCH, so a repeat run writes nothing new. The scopes of
 * each API join here with the API (dashboard-api in ticket 19a).
 */
export function scopeGrants(clients: { dashboardWeb: string }): [string, string][] {
  return Object.values(TENANCY_API_SCOPES).map((scope) => [scope, clients.dashboardWeb]);
}

async function writeScopeGrants(authz: Authz, grants: [string, string][]): Promise<void> {
  await authz.writeRelationships(
    grants.map(([scope, clientId]) =>
      touch(relationship(apiScope(scope), 'grantee', client(clientId))),
    ),
  );
}

async function main(): Promise<void> {
  // The schema first: SpiceDB is healthy before this container starts, and the tuples of later steps need it.
  // The channel stays open for the scope grants, which need the client IDs the Zitadel steps return.
  const authz = createAuthz(authzOptionsFromEnv());
  try {
    const schema = await ensureSchema(authz);
    log('schema', { action: schema.action });
    await configure(authz);
  } finally {
    authz.close();
  }
}

async function configure(authz: Authz): Promise<void> {
  const zitadelUrl = stripTrailingSlash(required('ZITADEL_URL'));
  const patFile = required('ZITADEL_PAT_FILE');
  const configDir = required('CONFIG_DIR');
  const dashboardWebUrl = stripTrailingSlash(required('DASHBOARD_WEB_URL'));
  const tenancyApiUrl = stripTrailingSlash(required('TENANCY_API_URL'));
  const seedPassword = required('SEED_USER_PASSWORD');

  // Then every package's migrations (docs/README.md §3.1: the packages own them, bootstrap only runs them),
  // before the seeds of ticket 12 and before the apps, which depend on this container, start.
  for (const [database, url] of [
    ['tenancy', required('TENANCY_DATABASE_URL')],
    ['documents', required('DOCUMENTS_DATABASE_URL')],
  ] as const) {
    const db = createDb(url, {}, { max: 1 });
    try {
      await runMigrations(db, fileURLToPath(new URL(`./migrations/${database}`, import.meta.url)));
      log('migrations', { database });
    } finally {
      await closeDb(db);
    }
  }

  log('zitadel.wait', { url: zitadelUrl });
  await waitForZitadel(zitadelUrl, READY_TIMEOUT_MS);
  const pat = (await readFile(patFile, 'utf8')).trim();
  if (!pat) throw new Error(`${patFile} is empty`);
  const api = new ZitadelClient(zitadelUrl, pat);
  const discovery = await fetchDiscovery(zitadelUrl);
  log('zitadel.ready', { issuer: discovery.issuer });

  const project = await ensureProject(api, PROJECT_NAME);
  log('project', { name: PROJECT_NAME, id: project.id, action: project.action });

  const app = await ensureOidcApp(
    api,
    project.id,
    DASHBOARD_WEB_APP,
    dashboardWebConfig(dashboardWebUrl),
  );
  log('application', { name: DASHBOARD_WEB_APP, id: app.appId, action: app.action });

  const tenancyApi = await ensureApiApp(api, project.id, TENANCY_API_APP, API_APP_CONFIG);
  log('application', { name: TENANCY_API_APP, id: tenancyApi.appId, action: tenancyApi.action });

  const grants = scopeGrants({ dashboardWeb: app.clientId });
  await writeScopeGrants(authz, grants);
  log('scope_grants', { count: grants.length, clients: { [DASHBOARD_WEB_APP]: app.clientId } });

  const users: Handoff['users'] = {};
  for (const seed of SEED_USERS) {
    const user = await ensureHumanUser(api, {
      username: seed.email,
      email: seed.email,
      givenName: seed.givenName,
      familyName: seed.familyName,
      password: seedPassword,
    });
    users[seed.key] = { id: user.id, email: seed.email };
    log('user', { username: seed.email, id: user.id, action: user.action });
  }

  const files = await writeHandoff(configDir, {
    issuer: discovery.issuer,
    jwksUrl: discovery.jwks_uri,
    userinfoUrl: discovery.userinfo_endpoint,
    projectId: project.id,
    dashboardWeb: { clientId: app.clientId, url: dashboardWebUrl },
    tenancyApiUrl,
    users,
  });
  log('handoff', { dir: configDir, files });
  log('done');
}

try {
  await main();
} catch (error) {
  logError('bootstrap.failed', error);
  process.exit(1);
}
