/** The Next.js binding with plain `Request`s: the cookies it sets and the responses of each route helper. */
import { beforeEach, describe, expect, it } from '@jest/globals';

import { createOidcClient } from '../oidc';
import { type Session, type SessionStore } from '../session';
import { createMemorySessionStore } from '../stores/memory';
import { createFakeOp, type FakeOp } from '../testing/fake-op';

import { createNextAuth, type NextAuth } from './index';

const APP = 'https://dashboard.test';
const options = {
  oidc: {
    issuer: 'https://op.test',
    clientId: 'dashboard-web',
    redirectUri: `${APP}/auth/callback`,
    postLogoutRedirectUri: `${APP}/`,
  },
  sessionSecret: 'dev-session-secret-needs-at-least-32-chars',
  redisUrl: 'redis://unused',
  appUrl: APP,
  cookieName: 'dashboard_web_session',
};
const alice = { sub: 'alice', email: 'alice@example.com', name: 'Alice', sid: 'sid-1' };

function setCookies(response: Response): Map<string, string> {
  return new Map(response.headers.getSetCookie().map((c) => [c.slice(0, c.indexOf('=')), c]));
}

function cookieHeader(...setCookies: string[]): string {
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

describe('createNextAuth', () => {
  let op: FakeOp;
  let store: SessionStore;
  let auth: NextAuth;
  const events: string[] = [];
  const records: Record<string, unknown>[] = [];

  beforeEach(async () => {
    events.length = 0;
    records.length = 0;
    op = await createFakeOp({ clientId: 'dashboard-web' });
    store = createMemorySessionStore();
    auth = createNextAuth({
      options,
      store,
      client: createOidcClient(options.oidc, { fetch: op.fetch, serverMetadata: op.metadata }),
      afterLoginPath: '/dashboard',
      logger: {
        warn: (event, fields) => {
          events.push(event);
          records.push(fields ?? {});
        },
      },
    });
  });

  async function loggedIn(): Promise<{ sessionCookie: string; sessionId: string }> {
    const login = await auth.login();
    const stash = setCookies(login).get('dashboard_web_session_login') as string;
    const callback = op.authorize(new URL(login.headers.get('location') as string), alice);
    const response = await auth.callback(
      new Request(callback, { headers: { cookie: cookieHeader(stash) } }),
    );
    const sessionCookie = setCookies(response).get('dashboard_web_session') as string;
    return { sessionCookie, sessionId: sessionCookie.split(';')[0]?.split('=')[1] as string };
  }

  it('login redirects to the OP and stashes the login in a signed cookie scoped to the callback', async () => {
    const response = await auth.login();
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toMatch(/^https:\/\/op\.test\/authorize\?/);
    const stash = setCookies(response).get('dashboard_web_session_login') as string;
    expect(stash).toMatch(/^dashboard_web_session_login=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
    expect(stash).toMatch(/; Path=\/auth\/callback/i);
    expect(stash).toMatch(/; Max-Age=600/i);
    expect(stash).toMatch(/; Secure/i);
    expect(stash).toMatch(/; HttpOnly/i);
    expect(stash).toMatch(/; SameSite=lax/i);
    expect(stash).not.toMatch(/Domain=/i);
  });

  it('callback creates the session, sets its cookie, clears the stash, and lands after login', async () => {
    const login = await auth.login();
    const stash = setCookies(login).get('dashboard_web_session_login') as string;
    const callback = op.authorize(new URL(login.headers.get('location') as string), alice);
    const response = await auth.callback(
      new Request(callback, { headers: { cookie: cookieHeader(stash) } }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${APP}/dashboard`);
    const cookies = setCookies(response);
    expect(cookies.get('dashboard_web_session')).toMatch(
      /^dashboard_web_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=lax$/i,
    );
    expect(cookies.get('dashboard_web_session_login')).toMatch(/Max-Age=0/i);
    const id = (cookies.get('dashboard_web_session') as string)
      .split(';')[0]
      ?.split('=')[1] as string;
    expect(await store.get(id)).toMatchObject({
      sub: 'alice',
      email: 'alice@example.com',
      sid: 'sid-1',
      amr: ['pwd'],
    });
  });

  it('callback answers every failure with the same generic response and logs the reason', async () => {
    const login = await auth.login();
    const stash = setCookies(login).get('dashboard_web_session_login') as string;
    const callback = op.authorize(new URL(login.headers.get('location') as string), alice);
    const other = setCookies(await auth.login()).get('dashboard_web_session_login') as string;

    const noStash = await auth.callback(new Request(callback));
    const wrongStash = await auth.callback(
      new Request(callback, { headers: { cookie: cookieHeader(other) } }),
    );
    const denied = await auth.callback(
      new Request(op.deny(new URL(login.headers.get('location') as string)), {
        headers: { cookie: cookieHeader(stash) },
      }),
    );
    for (const response of [noStash, wrongStash, denied]) {
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Login failed. Please try again.');
      expect(setCookies(response).get('dashboard_web_session_login')).toMatch(/Max-Age=0/i);
      expect(setCookies(response).has('dashboard_web_session')).toBe(false);
    }
    expect(events).toEqual(['auth.login_failed', 'auth.login_failed', 'auth.login_failed']);
    expect(records.map((r) => r.errorCode)).toEqual([
      'no_login_in_progress',
      'state_mismatch',
      'authorization_denied',
    ]);
    for (const record of records) {
      expect(JSON.stringify(record)).not.toMatch(/at-|\.ey|dashboard_web_session_login=/);
    }
    await expect(store.listByUser('alice')).resolves.toEqual([]);
  });

  /** The binding again, with a hook; the OP and the store are the ones of this test. */
  function withHook(onLogin: (session: Session) => Promise<void>): NextAuth {
    return createNextAuth({
      options,
      store,
      client: createOidcClient(options.oidc, { fetch: op.fetch, serverMetadata: op.metadata }),
      afterLoginPath: '/dashboard',
      onLogin,
      logger: {
        warn: (event, fields) => {
          events.push(event);
          records.push(fields ?? {});
        },
      },
    });
  }

  it('callback runs onLogin with the stored session before the browser is sent on', async () => {
    const seen: Session[] = [];
    const hooked = withHook(async (session) => {
      seen.push(session);
      // The session exists while the hook runs: provisioning can use its access token.
      expect(await store.get(session.id)).toBeDefined();
    });
    const login = await hooked.login();
    const stash = setCookies(login).get('dashboard_web_session_login') as string;
    const callback = op.authorize(new URL(login.headers.get('location') as string), alice);
    const response = await hooked.callback(
      new Request(callback, { headers: { cookie: cookieHeader(stash) } }),
    );
    expect(response.status).toBe(303);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sub: 'alice', email: 'alice@example.com' });
    expect(seen[0]?.accessToken).toMatch(/^at-/);
    const id = (setCookies(response).get('dashboard_web_session') as string)
      .split(';')[0]
      ?.split('=')[1] as string;
    expect(id).toBe(seen[0]?.id);
  });

  it('a failing onLogin fails the login: no session, no cookie, the generic response, the reason logged', async () => {
    const hooked = withHook(() => Promise.reject(new Error('POST /me/provision: 502 bad_gateway')));
    const login = await hooked.login();
    const stash = setCookies(login).get('dashboard_web_session_login') as string;
    const callback = op.authorize(new URL(login.headers.get('location') as string), alice);
    const response = await hooked.callback(
      new Request(callback, { headers: { cookie: cookieHeader(stash) } }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Login failed. Please try again.');
    expect(setCookies(response).has('dashboard_web_session')).toBe(false);
    expect(setCookies(response).get('dashboard_web_session_login')).toMatch(/Max-Age=0/i);
    await expect(store.listByUser('alice')).resolves.toEqual([]);
    expect(events).toEqual(['auth.login_failed']);
    expect(records[0]).toEqual({
      errorCode: 'login_hook_failed',
      reason: 'POST /me/provision: 502 bad_gateway',
    });
  });

  it('sessionFromRequest returns the live session behind the cookie', async () => {
    const { sessionCookie, sessionId } = await loggedIn();
    const session = await auth.sessionFromRequest(
      new Request(`${APP}/dashboard`, { headers: { cookie: cookieHeader(sessionCookie) } }),
    );
    expect(session?.id).toBe(sessionId);
    await expect(auth.sessionFromRequest(new Request(`${APP}/dashboard`))).resolves.toBeUndefined();
    await expect(
      auth.sessionFromRequest(
        new Request(`${APP}/dashboard`, { headers: { cookie: 'dashboard_web_session=nope' } }),
      ),
    ).resolves.toBeUndefined();
  });

  it('logout refuses a cross-origin POST and keeps the session', async () => {
    const { sessionCookie, sessionId } = await loggedIn();
    const response = await auth.logout(
      new Request(`${APP}/auth/logout`, {
        method: 'POST',
        headers: { cookie: cookieHeader(sessionCookie), origin: 'https://evil.test' },
      }),
    );
    expect(response.status).toBe(403);
    await expect(store.get(sessionId)).resolves.toBeDefined();
    expect(events).toContain('auth.logout_rejected');
  });

  it('logout deletes the session, clears the cookie, and ends the IdP session', async () => {
    const { sessionCookie, sessionId } = await loggedIn();
    const idToken = (await store.get(sessionId))?.idToken as string;
    const response = await auth.logout(
      new Request(`${APP}/auth/logout`, {
        method: 'POST',
        headers: { cookie: cookieHeader(sessionCookie), origin: APP },
      }),
    );
    expect(response.status).toBe(303);
    const target = new URL(response.headers.get('location') as string);
    expect(target.origin + target.pathname).toBe('https://op.test/end_session');
    expect(target.searchParams.get('id_token_hint')).toBe(idToken);
    expect(target.searchParams.get('post_logout_redirect_uri')).toBe(`${APP}/`);
    expect(setCookies(response).get('dashboard_web_session')).toMatch(
      /^dashboard_web_session=; Path=\/.*Max-Age=0/i,
    );
    await expect(store.get(sessionId)).resolves.toBeUndefined();

    const noSession = await auth.logout(
      new Request(`${APP}/auth/logout`, { method: 'POST', headers: { origin: APP } }),
    );
    expect(noSession.headers.get('location')).toBe(`${APP}/`);
  });

  it('backchannelLogout removes the session the IdP names, with no origin check and no cookie', async () => {
    const { sessionId } = await loggedIn();
    const token = await op.sign({
      iss: 'https://op.test',
      aud: 'dashboard-web',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 120,
      jti: 'jti-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      sid: 'sid-1',
      sub: 'alice',
    });
    const response = await auth.backchannelLogout(
      new Request(`${APP}/auth/backchannel-logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ logout_token: token }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('location')).toBeNull();
    expect(setCookies(response).size).toBe(0);
    await expect(store.get(sessionId)).resolves.toBeUndefined();

    const refused = await auth.backchannelLogout(
      new Request(`${APP}/auth/backchannel-logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ logout_token: 'garbage' }),
      }),
    );
    expect(refused.status).toBe(400);
    expect(events).toContain('auth.backchannel_logout_rejected');
  });
});
