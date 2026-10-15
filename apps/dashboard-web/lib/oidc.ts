import * as client from 'openid-client';

/**
 * OIDC client of the spike (ticket 3): discovery against the issuer from the environment, cached per process.
 * Ticket 8 moves this into packages/auth; nothing here is final.
 */

export interface OidcEnv {
  issuer: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function oidcEnv(): OidcEnv {
  return {
    issuer: required('OIDC_ISSUER'),
    clientId: required('OIDC_CLIENT_ID'),
    redirectUri: required('OIDC_REDIRECT_URI'),
    postLogoutRedirectUri: required('OIDC_POST_LOGOUT_REDIRECT_URI'),
  };
}

let configuration: Promise<client.Configuration> | undefined;

export function oidcConfiguration(): Promise<client.Configuration> {
  configuration ??= (async () => {
    const env = oidcEnv();
    return client.discovery(
      new URL(env.issuer),
      env.clientId,
      undefined,
      // Public client with PKCE: the token request carries client_id only.
      client.None(),
      // The issuer is plain http in compose; openid-client refuses that unless told otherwise.
      env.issuer.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : {},
    );
  })();
  return configuration;
}

/** Values stashed in a short-lived cookie between the login redirect and the callback. */
export interface LoginStash {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export const LOGIN_COOKIE = 'dashboard_login';
export const CLAIMS_COOKIE = 'dashboard_claims';
