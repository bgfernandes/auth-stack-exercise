/**
 * `@auth-stack/auth/next`: the core bound to Next.js route handlers (`Request` in, `NextResponse` out) and to
 * `cookies()` for server components. The routes of a BFF (docs/README.md §4.4; ticket 9 for dashboard-web) are
 * one call each: `GET /auth/login` → `login()`, `GET /auth/callback` → `callback(request)`, `POST /auth/logout`
 * → `logout(request)`, `POST /auth/backchannel-logout` → `backchannelLogout(request)`. Nothing here decides
 * anything the core does not; it only moves cookies, and runs the host's `onLogin` hook (§4.4 step 4,
 * just-in-time provisioning) between the session's creation and the redirect. `securityHeaders(request)` is
 * for `proxy.ts`: the headers of §9 on every response, with the nonce Next.js stamps on its own scripts.
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { createAccessTokenProvider, type AccessTokenProvider } from '../access-token';
import { handleBackchannelLogout } from '../backchannel-logout';
import { assertSameOrigin, cookieAttributes, readCookie, type CookieAttributes } from '../cookies';
import { CSRF_FIELD, csrfTokenOf, verifyCsrfToken } from '../csrf';
import { AuthError } from '../errors';
import { newNonce, webSecurityHeaders } from '../headers';
import { createOidcClient, type OidcClient, type TokenTypeHint } from '../oidc';
import { redact, type AuthLogger } from '../redact';
import { sessionFromLogin, type Session, type SessionStore } from '../session';
import { openStash, sealStash, STASH_LIFETIME_SECONDS } from '../stash';

import type { AuthOptions } from '../env';

export interface NextAuthOptions {
  /** From `authOptionsFromEnv`. */
  options: AuthOptions;
  store: SessionStore;
  /** Defaults to `createOidcClient(options.oidc)`. */
  client?: OidcClient;
  /** Where a completed login lands; `/` by default. */
  afterLoginPath?: string;
  /**
   * Runs on every completed login with the new session, before the browser is sent on and before the session
   * cookie exists (docs/README.md §4.4 step 4: the provisioning calls, with `session.accessToken`). It may
   * return where this login lands instead of `afterLoginPath`: a path relative to the app's own origin (a
   * first login landing on a page that lists what the hook just created, §6.4). A throw fails the login: the
   * session is deleted, no cookie is set, the browser gets the generic failed response, and the reason is
   * logged under `login_hook_failed`; a returned path that resolves outside the app's origin counts as a throw,
   * since it is a bug of the host, never a redirect elsewhere.
   */
  onLogin?: (session: Session) => Promise<string | void>;
  /** The response of the callback when the login fails, whatever the reason; a plain 400 by default. */
  loginFailed?: (code: AuthError['code']) => NextResponse;
  logger?: AuthLogger;
  now?: () => number;
  /** Relaxes the policy for `next dev` (§9); `NODE_ENV === 'development'` by default. */
  development?: boolean;
}

/** What `securityHeaders(request)` gives `proxy.ts`. */
export interface SecuredResponses {
  /** Continues to the page, the policy on the request as well, so Next.js stamps the nonce on its own scripts. */
  next(): NextResponse;
  /** Sets the headers on any other response of the proxy (a redirect to the login). */
  apply<T extends NextResponse>(response: T): T;
}

export interface NextAuth {
  readonly cookieName: string;
  /** Starts a login: a redirect to the authorization endpoint with the stash cookie set. */
  login(): Promise<NextResponse>;
  /** Completes a login: the session is created and its cookie set; any failure is the generic failed response. */
  callback(request: Request): Promise<NextResponse>;
  /** Ends the session, revokes its tokens, and sends the browser to the IdP's end-session endpoint; a same-origin form carrying the session's token only. */
  logout(request: Request): Promise<NextResponse>;
  /** The back-channel logout sink (§4.4 step 6): the IdP's logout token in, the sessions it names gone. */
  backchannelLogout(request: Request): Promise<NextResponse>;
  /** The live session behind a request's cookie (route handlers, `proxy.ts`), marked seen; undefined otherwise. */
  sessionFromRequest(request: Request): Promise<Session | undefined>;
  /** The live session behind `cookies()` (server components, server actions), marked seen; undefined otherwise. */
  currentSession(): Promise<Session | undefined>;
  /** The synchronizer token of the session (§9, "CSRF"), for the hidden `CSRF_FIELD` of every form. */
  csrfTokenOf(session: Pick<Session, 'id'>): string;
  /** Whether a form's `CSRF_FIELD` value is the session's token; never throws. */
  verifyCsrfToken(session: Pick<Session, 'id'>, presented: unknown): boolean;
  /** The token of the session behind `cookies()`, for pages; undefined without a live session. */
  csrfToken(): Promise<string | undefined>;
  /** For `proxy.ts`: the security headers of one response (§9), a fresh nonce in its policy. */
  securityHeaders(request: Request): SecuredResponses;
  getAccessToken: AccessTokenProvider['getAccessToken'];
}

/** Rolling-expiry writes are throttled: one `touch` per session per minute at most. */
const TOUCH_INTERVAL_MS = 60_000;

export function createNextAuth(init: NextAuthOptions): NextAuth {
  const { options, store, logger } = init;
  const now = init.now ?? Date.now;
  const client = init.client ?? createOidcClient(options.oidc);
  const tokens = createAccessTokenProvider({ client, store, now, ...(logger ? { logger } : {}) });
  const cookieName = options.cookieName;
  const stashCookieName = `${cookieName}_login`;
  const sessionCookie = cookieAttributes({ appUrl: options.appUrl });
  const stashCookie = cookieAttributes({
    appUrl: options.appUrl,
    path: new URL(options.oidc.redirectUri).pathname,
    maxAge: STASH_LIFETIME_SECONDS,
  });
  const afterLoginUrl = new URL(init.afterLoginPath ?? '/', options.appUrl);
  const development = init.development ?? process.env.NODE_ENV === 'development';

  /** A landing path the hook returned, resolved as `afterLoginPath` is; one that lands elsewhere is refused. */
  function landingUrl(path: string): URL {
    const url = new URL(path, options.appUrl);
    if (url.origin !== afterLoginUrl.origin)
      throw new Error(`onLogin returned a landing path outside the app: ${path}`);
    return url;
  }
  const loginFailed =
    init.loginFailed ??
    (() => new NextResponse('Login failed. Please try again.', { status: 400 }));

  const clear = (response: NextResponse, name: string, attributes: CookieAttributes) =>
    response.cookies.set(name, '', { ...attributes, maxAge: 0 });

  async function revokeTokens(session: Session): Promise<void> {
    const tokens: [string | undefined, TokenTypeHint][] = [
      [session.refreshToken, 'refresh_token'],
      [session.accessToken, 'access_token'],
    ];
    for (const [token, tokenTypeHint] of tokens) {
      if (!token) continue;
      try {
        await client.revoke(token, tokenTypeHint);
      } catch (error) {
        logger?.warn(
          'auth.revocation_failed',
          redact({
            tokenTypeHint,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }

  async function liveSession(id: string | undefined): Promise<Session | undefined> {
    if (!id) return undefined;
    const session = await store.get(id);
    if (!session) return undefined;
    if (now() - session.lastSeenAt >= TOUCH_INTERVAL_MS && !(await store.touch(id)))
      return undefined;
    return session;
  }

  return {
    cookieName,

    async login() {
      const { url, stash } = await client.beginLogin();
      const response = NextResponse.redirect(url);
      response.cookies.set(stashCookieName, sealStash(stash, options.sessionSecret), stashCookie);
      return response;
    },

    async callback(request) {
      let response: NextResponse;
      try {
        const stash = openStash(
          readCookie(request.headers.get('cookie'), stashCookieName),
          options.sessionSecret,
          now(),
        );
        const login = await client.completeLogin(new URL(request.url), stash);
        const session = await store.create(sessionFromLogin(login));
        let landing = afterLoginUrl;
        if (init.onLogin) {
          try {
            const path = await init.onLogin(session);
            if (path !== undefined) landing = landingUrl(path);
          } catch (error) {
            // No session without its provisioning: the next login runs the hook again.
            await store.delete(session.id);
            throw new AuthError(
              'login_hook_failed',
              error instanceof Error ? error.message : String(error),
              { cause: error },
            );
          }
        }
        response = NextResponse.redirect(landing, 303);
        response.cookies.set(cookieName, session.id, sessionCookie);
      } catch (error) {
        const code = error instanceof AuthError ? error.code : 'token_invalid';
        // Not `code`: `redact` blanks that key, since it is also the name of the authorization code.
        logger?.warn(
          'auth.login_failed',
          redact({
            errorCode: code,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
        response = loginFailed(code);
      }
      clear(response, stashCookieName, stashCookie);
      return response;
    },

    async logout(request) {
      try {
        assertSameOrigin(request, options.appUrl);
      } catch (error) {
        logger?.warn(
          'auth.logout_rejected',
          redact({ reason: error instanceof Error ? error.message : 'origin' }),
        );
        return new NextResponse('Forbidden', { status: 403 });
      }
      const id = readCookie(request.headers.get('cookie'), cookieName);
      const session = id ? await store.get(id) : undefined;
      // The form's synchronizer token (§9, "CSRF"): a request with a session must carry the session's; one
      // without a session has nothing to forge and is answered as before, its cookie cleared.
      if (session) {
        const presented = await formField(request, CSRF_FIELD);
        if (!verifyCsrfToken(session, options.sessionSecret, presented)) {
          logger?.warn(
            'auth.logout_rejected',
            redact({
              errorCode: 'csrf_token_invalid',
              reason: presented
                ? `${CSRF_FIELD} is not the session's`
                : `form carries no ${CSRF_FIELD}`,
            }),
          );
          return new NextResponse('Forbidden', { status: 403 });
        }
      }
      if (id) await store.delete(id);
      // The tokens the session held are revoked at the issuer (RFC 7009), the refresh token first: a stolen
      // refresh token mints new access tokens, an access token is bounded by its ten minutes. Best effort: the
      // session is already gone, and a logout never fails because the revocation did.
      if (session) await revokeTokens(session);
      // The IdP session ends too (§4.4 step 5); without a session of our own there is no ID token to hint with.
      const target = session
        ? await client.endSessionUrl(session.idToken)
        : new URL(options.oidc.postLogoutRedirectUri);
      const response = NextResponse.redirect(target, 303);
      clear(response, cookieName, sessionCookie);
      return response;
    },

    async backchannelLogout(request) {
      const response = await handleBackchannelLogout(request, {
        client,
        store,
        ...(logger ? { logger } : {}),
      });
      return new NextResponse(response.body, response);
    },

    sessionFromRequest(request) {
      return liveSession(readCookie(request.headers.get('cookie'), cookieName));
    },

    async currentSession() {
      return liveSession((await cookies()).get(cookieName)?.value);
    },

    csrfTokenOf(session) {
      return csrfTokenOf(session, options.sessionSecret);
    },

    verifyCsrfToken(session, presented) {
      return verifyCsrfToken(session, options.sessionSecret, presented);
    },

    async csrfToken() {
      const session = await this.currentSession();
      return session && csrfTokenOf(session, options.sessionSecret);
    },

    securityHeaders(request) {
      const headers = webSecurityHeaders({
        appUrl: options.appUrl,
        issuer: options.oidc.issuer,
        nonce: newNonce(),
        development,
      });
      const apply = <T extends NextResponse>(response: T): T => {
        for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
        return response;
      };
      return {
        next() {
          const requestHeaders = new Headers(request.headers);
          requestHeaders.set(
            'content-security-policy',
            headers['Content-Security-Policy'] as string,
          );
          return apply(NextResponse.next({ request: { headers: requestHeaders } }));
        },
        apply,
      };
    },

    getAccessToken: tokens.getAccessToken,
  };
}

/** One text field of a posted form; undefined when the request carries no form (a crafted request) or the field. */
async function formField(request: Request, name: string): Promise<string | undefined> {
  try {
    const value = (await request.formData()).get(name);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}
