import { describe, expect, it } from '@jest/globals';

import { authOptionsFromEnv } from './env';

const env = {
  OIDC_ISSUER: 'https://auth.localtest.me:8443',
  OIDC_CLIENT_ID: 'client-1',
  OIDC_REDIRECT_URI: 'http://dashboard.localtest.me:3000/auth/callback',
  OIDC_POST_LOGOUT_REDIRECT_URI: 'http://dashboard.localtest.me:3000/',
  SESSION_SECRET: 'dev-session-secret-needs-at-least-32-chars',
  REDIS_URL: 'redis://localhost:6379',
  APP_URL: 'http://dashboard.localtest.me:3000',
};

describe('authOptionsFromEnv', () => {
  it('reads the contract and derives the cookie name from the app', () => {
    expect(authOptionsFromEnv(env, { app: 'dashboard-web' })).toEqual({
      oidc: {
        issuer: env.OIDC_ISSUER,
        clientId: 'client-1',
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
});
