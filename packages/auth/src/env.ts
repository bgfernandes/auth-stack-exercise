/**
 * The env contract of a BFF (docs/TICKETS.md tickets 8 and 4a): the six `OIDC_*` values bootstrap writes to the
 * app's handoff file, the client key among them, plus the app's own. Read once at startup; a missing or
 * malformed value fails the process rather than the first login.
 */
import { createPrivateKey } from 'node:crypto';

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

/**
 * `OIDC_CLIENT_KEY` is the PKCS#8 PEM of the client's RSA key on one base64 line, the way bootstrap writes it so
 * a shell can source the file. Decoded and parsed here, so a key that is not one fails the start; the error
 * names the variable and never carries the value.
 */
function clientKeyPem(env: NodeJS.ProcessEnv): string {
  const pem = Buffer.from(required(env, 'OIDC_CLIENT_KEY'), 'base64').toString('utf8');
  let type: string | undefined;
  try {
    type = createPrivateKey(pem).asymmetricKeyType;
  } catch {
    throw new Error('OIDC_CLIENT_KEY is not a base64-encoded PEM private key');
  }
  if (type !== 'rsa')
    throw new Error(`OIDC_CLIENT_KEY is a ${type ?? 'non-RSA'} key; RSA is required`);
  return pem;
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
      clientKey: { kid: required(env, 'OIDC_CLIENT_KEY_ID'), pem: clientKeyPem(env) },
      redirectUri: url(env, 'OIDC_REDIRECT_URI'),
      postLogoutRedirectUri: url(env, 'OIDC_POST_LOGOUT_REDIRECT_URI'),
    },
    sessionSecret,
    redisUrl: url(env, 'REDIS_URL'),
    appUrl: url(env, 'APP_URL'),
    cookieName: env.SESSION_COOKIE_NAME || `${options.app.replace(/[^a-z0-9]+/gi, '_')}_session`,
  };
}
