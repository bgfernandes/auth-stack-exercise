/**
 * The env contract of a BFF (docs/TICKETS.md ticket 8): the four `OIDC_*` values bootstrap writes to the app's
 * handoff file, plus the app's own. Read once at startup; a missing or malformed value fails the process rather
 * than the first login.
 */
import { MIN_SECRET_LENGTH } from './stash';

import type { OidcClientConfig } from './oidc';

export interface AuthOptions {
  oidc: OidcClientConfig;
  /** Signs the login stash cookie; at least 32 characters. */
  sessionSecret: string;
  redisUrl: string;
  /** The app's public URL: decides `Secure` on the cookies and is the origin `assertSameOrigin` expects. */
  appUrl: string;
  /** Distinct per app, since the BFFs share `localtest.me` and its subdomains' cookies are not isolated by port. */
  cookieName: string;
}

export interface AuthEnvOptions {
  /** The app's name, for the default cookie name (`dashboard-web` gives `dashboard_web_session`). */
  app: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

function url(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  return value;
}

export function authOptionsFromEnv(env: NodeJS.ProcessEnv, options: AuthEnvOptions): AuthOptions {
  const sessionSecret = required(env, 'SESSION_SECRET');
  if (sessionSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return {
    oidc: {
      issuer: url(env, 'OIDC_ISSUER'),
      clientId: required(env, 'OIDC_CLIENT_ID'),
      redirectUri: url(env, 'OIDC_REDIRECT_URI'),
      postLogoutRedirectUri: url(env, 'OIDC_POST_LOGOUT_REDIRECT_URI'),
    },
    sessionSecret,
    redisUrl: url(env, 'REDIS_URL'),
    appUrl: url(env, 'APP_URL'),
    cookieName: env.SESSION_COOKIE_NAME || `${options.app.replace(/[^a-z0-9]+/gi, '_')}_session`,
  };
}
