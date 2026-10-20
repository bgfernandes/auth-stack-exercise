import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import { authOptionsFromEnv } from './env';

/** A client key as bootstrap writes it: the PKCS#8 PEM on one base64 line. */
const pem = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const ecPem = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const base64 = (text: string) => Buffer.from(text).toString('base64');

const env = {
  OIDC_ISSUER: 'https://auth.localtest.me:8443',
  OIDC_CLIENT_ID: 'client-1',
  OIDC_CLIENT_KEY_ID: 'key-1',
  OIDC_CLIENT_KEY: base64(pem),
  OIDC_REDIRECT_URI: 'http://dashboard.localtest.me:3000/auth/callback',
  OIDC_POST_LOGOUT_REDIRECT_URI: 'http://dashboard.localtest.me:3000/',
  SESSION_SECRET: 'dev-session-secret-needs-at-least-32-chars',
  REDIS_URL: 'redis://localhost:6379',
  APP_URL: 'http://dashboard.localtest.me:3000',
};

describe('authOptionsFromEnv', () => {
  it('reads the contract, decodes the client key, and derives the cookie name from the app', () => {
    expect(authOptionsFromEnv(env, { app: 'dashboard-web' })).toEqual({
      oidc: {
        issuer: env.OIDC_ISSUER,
        clientId: 'client-1',
        clientKey: { kid: 'key-1', pem },
        redirectUri: env.OIDC_REDIRECT_URI,
        postLogoutRedirectUri: env.OIDC_POST_LOGOUT_REDIRECT_URI,
      },
      sessionSecret: env.SESSION_SECRET,
      redisUrl: env.REDIS_URL,
      appUrl: env.APP_URL,
      cookieName: 'dashboard_web_session',
    });
    expect(
      authOptionsFromEnv({ ...env, SESSION_COOKIE_NAME: 'dash' }, { app: 'dashboard-web' })
        .cookieName,
    ).toBe('dash');
  });

  it('fails on a missing variable, a short secret, or a value that is not a URL', () => {
    for (const name of Object.keys(env)) {
      const rest: NodeJS.ProcessEnv = { ...env };
      delete rest[name];
      expect(() => authOptionsFromEnv(rest, { app: 'x' })).toThrow(name);
    }
    expect(() => authOptionsFromEnv({ ...env, SESSION_SECRET: 'short' }, { app: 'x' })).toThrow(
      'SESSION_SECRET',
    );
    expect(() => authOptionsFromEnv({ ...env, APP_URL: 'dashboard' }, { app: 'x' })).toThrow(
      'APP_URL',
    );
  });

  it('fails on a client key that is not an RSA private key, without repeating the value', () => {
    for (const value of [base64('not a key'), pem, base64(ecPem)]) {
      let message = '';
      try {
        authOptionsFromEnv({ ...env, OIDC_CLIENT_KEY: value }, { app: 'x' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^OIDC_CLIENT_KEY is/);
      expect(message).not.toContain('PRIVATE KEY');
      expect(message).not.toContain(value);
    }
  });
});
