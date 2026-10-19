# `@auth-stack/auth`

The one place OIDC and session details live ([`docs/README.md`](../../docs/README.md) §4.4, §6.7, §9). For the BFFs: an OIDC client over `openid-client` v6 (authorization code with PKCE `S256`, `state` and `nonce` bound to the login attempt, ID-token validation, refresh, RP-initiated logout), the server-side session and its `SessionStore` with in-memory and Redis adapters, an access-token provider that refreshes on demand, the back-channel logout sink, cookie and same-origin helpers, and `redact` for logs; `@auth-stack/auth/next` binds them to Next.js route handlers. For the APIs: bearer verification and the scope gate, bound to Fastify by `@auth-stack/auth/fastify`. The core works on the Fetch API's `Request` and `Response` and depends on neither framework. The authentication-context policy helper is ticket 24.

## Configuration

A BFF: `authOptionsFromEnv(process.env, { app })` reads the contract; every value is checked at startup.

| Variable | Meaning |
| --- | --- |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `OIDC_POST_LOGOUT_REDIRECT_URI` | The application bootstrap registered; written to the app's `.local/config/<app>.env` by the bootstrap container |
| `APP_URL` | The app's public URL (also from the handoff file): its scheme decides `Secure` on the cookies, its origin is what `assertSameOrigin` expects |
| `SESSION_SECRET` | Signs the login stash cookie; at least 32 characters (`.env` carries a development value) |
| `REDIS_URL` | The session store (`redis://redis:6379` inside compose, `localhost` from the host) |
| `SESSION_COOKIE_NAME` | Optional; defaults to `<app>_session` (`dashboard_web_session`). Distinct per app: the BFFs share `localtest.me`, and cookies are not isolated by port |

An API: `bearerOptionsFromEnv()` reads the three values of `.local/config/apis.env`, written by bootstrap.

| Variable | Meaning |
| --- | --- |
| `OIDC_ISSUER` | What `iss` must be |
| `OIDC_PROJECT_ID` | What `aud` must contain: every API is an application of the one Zitadel project |
| `OIDC_JWKS_URL` | Where the signing keys are fetched from (cached by jose) |

## Usage

```ts
import { Redis } from 'ioredis';

import { authOptionsFromEnv, createRedisSessionStore } from '@auth-stack/auth';
import { createNextAuth } from '@auth-stack/auth/next';

const options = authOptionsFromEnv(process.env, { app: 'dashboard-web' });
const store = createRedisSessionStore(new Redis(options.redisUrl), { prefix: 'dashboard-web' });
export const auth = createNextAuth({ options, store, afterLoginPath: '/dashboard', onLogin: provisionWorkspace });

// app/auth/login/route.ts      export const GET = () => auth.login();
// app/auth/callback/route.ts   export const GET = (request: Request) => auth.callback(request);
// app/auth/logout/route.ts     export const POST = (request: Request) => auth.logout(request); // the form carries CSRF_FIELD
// app/auth/backchannel-logout/route.ts   export const POST = (request: Request) => auth.backchannelLogout(request);
// a server component           const session = await auth.currentSession();
// proxy.ts or a route handler  const session = await auth.sessionFromRequest(request);
// proxy.ts                      const secured = auth.securityHeaders(request); return secured.next(); // or secured.apply(redirect)
// calling an API               const token = await auth.getAccessToken(session); // undefined: send to login
```

`login()` redirects to the authorization endpoint and seals `state`, `nonce`, and the PKCE verifier into a signed cookie scoped to the callback path, valid ten minutes. `callback(request)` verifies the callback against that stash, exchanges the code, validates the tokens, creates the session, runs `onLogin(session)` when the app gives one (the just-in-time provisioning calls of §6.4, with `session.accessToken`; a throw deletes the session again and fails the login), sets the session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` over https, `Path=/`, no `Domain`), and redirects to `afterLoginPath`, or to the path `onLogin` returned, when it returns one: a path relative to the app's own origin, for a first login that lands on a page listing what the hook just created (§6.4); a returned path that resolves anywhere else is a bug of the host and fails the login like a throw, never a redirect elsewhere; every failure gets the same generic response (a plain `400`, or what `loginFailed` returns) while the reason is logged through the `logger` option with `redact` applied. The token request always carries the registered redirect URI, never the host the server saw the request on (the standalone Next.js server reports its bind address). `logout(request)` accepts same-origin requests only (`Origin`, falling back to `Sec-Fetch-Site`) and, when there is a session, only a form carrying its synchronizer token (below; `403` otherwise, the session kept), deletes the session, revokes its refresh token and then its access token at the IdP's `revocation_endpoint` (RFC 7009, with `token_type_hint`; a failed revocation is logged as `auth.revocation_failed` and never fails the logout, the session being gone already), clears the cookie, and redirects to the IdP's `end_session_endpoint` with `id_token_hint`, so the IdP session ends too; a request without a session clears the cookie and redirects, there being nothing to forge. The session helpers return the live session or `undefined`, and mark it seen at most once a minute.

`backchannelLogout(request)` is the sink of OpenID Connect Back-Channel Logout 1.0 (§4.4 step 6), the URL bootstrap registers as the application's `backchannel_logout_uri`: the IdP posts `logout_token=<JWT>` as a form, server to server, when the user's IdP session ends, in the same request to every application of that session. The token is validated like an ID token against the issuer's JWKS from discovery (signature, `iss`, `aud` containing the client ID, `exp`, `iat` required) and then on what makes it a logout token: an `events` member of `http://schemas.openid.net/event/backchannel-logout`, no `nonce`, and a `sid`, a `sub`, or both; an ID token of the same issuer is refused on the last two. The sessions the token names go through `deleteByLogoutToken`, and the answer is `200` with no body, also when nothing matched; a request without a valid token gets `400` with `{ "error": "invalid_request" }`; a failing store propagates as a `500`, which the IdP may retry where a `400` is final. Never a redirect, no cookie read or set, no origin check: there is no browser in this exchange, and the signed token is the request's authentication. The outcome is logged as `auth.backchannel_logout` with the count removed and which claims the token carried, through the logger's `info` when it has one, never the `sid` or the session IDs; a refusal as `auth.backchannel_logout_rejected` with the code. A replayed token can only remove what its first delivery removed, so no `jti` cache is kept. Zitadel posts the token to every application that obtained tokens in the IdP session, on `end_session` and on a termination through its session API alike, with `sid` and `sub` both set, `typ: JWT`, and `aud` the client ID alone (observed 2026-10-18, ticket 18).

The core is the same without Next.js:

```ts
import { createAccessTokenProvider, createOidcClient, handleBackchannelLogout, openStash, sealStash, sessionFromLogin } from '@auth-stack/auth';

const client = createOidcClient(options.oidc); // discovery once per process
const { url, stash } = await client.beginLogin(); // redirect to url; sealStash(stash, secret) into a cookie
const login = await client.completeLogin(callbackUrl, openStash(cookie, secret, Date.now()));
const session = await store.create(sessionFromLogin(login));
const { getAccessToken } = createAccessTokenProvider({ client, store });
await client.revoke(session.refreshToken, 'refresh_token'); // at logout; throws AuthError('revocation_failed')
const response = await handleBackchannelLogout(request, { client, store }); // a plain Response, for any framework
```

Failures are `AuthError`s with a `code`: `no_login_in_progress`, `login_expired`, `state_mismatch`, `nonce_mismatch`, `authorization_denied`, `exchange_failed`, `token_invalid`, `refresh_failed`, `revocation_failed`, `forbidden_origin`, `login_hook_failed`, `logout_token_invalid`. The error message never carries a token; log records go through `redact()`, which blanks credential-bearing fields (`accessToken`, `refresh_token`, `cookie`, `authorization`, `password`, ...) at any depth.

`getAccessToken(session)` returns the stored token while it has more than a minute left, otherwise refreshes through the refresh token and writes the rotated pair back with `update`. Concurrent calls for one session share one refresh; a refused refresh re-reads the session in case another process refreshed first, and on `invalid_grant` deletes the session and returns `undefined`, which the caller turns into a login redirect.

## Forms: the synchronizer token (BFFs)

The third CSRF layer of §9, after the session cookie's `SameSite=Lax` and `assertSameOrigin(request, appUrl)` (`Origin`, falling back to `Sec-Fetch-Site`): every form of a BFF carries a hidden field named `CSRF_FIELD` (`csrf_token`) whose value is `csrfTokenOf(session, sessionSecret)`, the HMAC-SHA256 of the session ID keyed with `SESSION_SECRET`, `base64url`; a handler verifies the posted value with `verifyCsrfToken(session, sessionSecret, presented)`, constant-time, false for anything that is not the session's token and never a throw. The token is derived, not stored: nothing is added to the session, it rotates with the session, and a page only ever shows an HMAC, never the ID. The Next.js binding carries the secret: `auth.csrfTokenOf(session)`, `auth.verifyCsrfToken(session, presented)`, and `auth.csrfToken()` for a page, the token of the session behind `cookies()` or `undefined` without one; its own `logout` verifies the token of its form. A handler verifies in this order: the origin, the session, the body, the token, and only then anything that costs a call, so a crafted post answers the same for every ID.

```ts
// a page                       <input type="hidden" name={CSRF_FIELD} value={await auth.csrfToken()} />
// a form's route handler       if (!auth.verifyCsrfToken(session, form.get(CSRF_FIELD))) return new Response('Forbidden', { status: 403 });
```

## Security headers (both kinds of app)

The headers of §9 come from one place, so the two web apps and the two APIs cannot drift. `webSecurityHeaders({ appUrl, issuer, nonce, development })` returns a web app's set: a `Content-Security-Policy` that allows no inline script or style but the ones carrying `nonce` (`script-src 'self' 'nonce-…' 'strict-dynamic'`, `style-src 'self' 'nonce-…'`, `default-src 'self'`, `img-src`, `font-src`, and `connect-src` `'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, and `form-action 'self'` plus the issuer's origin, because the logout form is answered with a redirect to the end-session endpoint and Chromium applies the directive to that redirect), `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, and, only when `appUrl` is `https`, as `Secure` on the cookie is, `Strict-Transport-Security` and `upgrade-insecure-requests`, which would break a plain-HTTP localhost; `development` adds `'unsafe-eval'` for scripts and replaces the styles' nonce with `'unsafe-inline'`, what Next.js's guide says `next dev` needs (a nonce beside `'unsafe-inline'` would disable it). `newNonce()` is 128 random bits. The Next.js binding does it per request for `proxy.ts`: `auth.securityHeaders(request)` mints the nonce and gives `next()`, which continues to the page with the policy on the request as well, where Next.js reads the nonce and stamps it on its own scripts, and `apply(response)` for any other response of the proxy; `development` is an option of `createNextAuth`, `NODE_ENV === 'development'` by default. The APIs register `apiSecurityHeaders(fastify)` from `@auth-stack/auth/fastify`, an `onSend` hook setting `API_SECURITY_HEADERS` on every response, errors included: `default-src 'none'; frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cache-Control: no-store`; no HSTS, since no browser reaches an API and TLS terminates at the edge.

## Bearer verification and the scope gate (APIs)

```ts
import Fastify from 'fastify';

import { bearerOptionsFromEnv, createBearerVerifier } from '@auth-stack/auth';
import { apiServerOptions, bearerPlugin, echoRequestId } from '@auth-stack/auth/fastify';
import { createScopeResolver } from '@auth-stack/client-scopes';

const app = Fastify(apiServerOptions());
echoRequestId(app);
await app.register(bearerPlugin, {
  verifier: createBearerVerifier(bearerOptionsFromEnv()),
  scopes: createScopeResolver(authz), // or fromScopeClaim, for a provider that emits `scope`
});
app.get('/health', { config: { public: true } }, () => ({ ok: true }));
app.get('/organizations', { preHandler: app.requireScope('tenancy:read') }, (request) => {
  const { sub, clientId } = request.principal!; // verified before any handler runs
  // ... the SpiceDB check on `sub` follows (§6.5)
});
```

Deny by default: once the plugin is registered, every route needs a valid bearer token unless it declares `config: { public: true }`. `createBearerVerifier` verifies the JWT locally against the JWKS (`iss`, `exp` with 30 s of tolerance, `aud` containing the project ID) and requires `client_id`, the claim RFC 9068 mandates and Zitadel emits (it emits no `azp` and no `scope` in access tokens, verified in ticket 15); a token carrying `at_hash` or `nonce` is an ID token and is refused, since an ID token of the same issuer would otherwise pass every check. The verified caller is `request.principal` (`sub`, `clientId`, `claims`). `requireScope(...)` resolves the client's scopes through the `ScopeResolver` (one lookup per client, cached a minute, in `@auth-stack/client-scopes`; `fromScopeClaim` reads the `scope` claim instead) and requires every named one; scope strings are validated when the route is declared. Responses follow RFC 6750 §3: `401` with `WWW-Authenticate: Bearer` (no token) or `Bearer error="invalid_token"`, `403` with `Bearer error="insufficient_scope", scope="..."`; the body is `{ "error": "<code>" }` and the reason goes to the log only.

`apiServerOptions()` gives every API the same request IDs (a well-formed inbound `X-Request-Id` is kept so a BFF's ID follows the request; anything else is replaced by a UUID; logged as `requestId`) and log redaction of `authorization`, `cookie`, and `set-cookie` headers. `echoRequestId(app)` echoes the ID on responses.

## Sessions and stores

A session is `{ id, sub, email, name, sid, accessToken, refreshToken, idToken, accessTokenExpiresAt, authTime, amr, createdAt, lastSeenAt, absoluteExpiresAt }` (timestamps in epoch milliseconds; `sid`, `auth_time`, and `amr` come from the ID token, the evidence the authentication-context policies of §9.1 use). The browser only ever holds the opaque `id`.

`SessionStore` is modelled on the `sessionStore` of Auth0's `nextjs-auth0`: `create`, `get` (applies the idle limit of 30 minutes and the absolute limit of 8 hours; the limits are an option), `touch` and `update` (write only to a session that still exists and report whether they did, so a rolling write or a refresh in flight during a logout never recreates it; no upsert exists), `delete`, `deleteByLogoutToken({ sid, sub })` (with `sid`, the sessions of that IdP session, also matching `sub` when both are given; with `sub` alone, every session of the user), `deleteByUser`, `listByUser`.

Picking a store: `createMemorySessionStore()` for tests and single-process development; `createRedisSessionStore(client, { prefix })` for everything else, where `client` is any `ioredis`-compatible object with `eval`, `hgetall`, `smembers`, and `srem` (the package does not depend on `ioredis`; the app does). Each app passes its own `prefix`, since the BFFs share one Redis and the per-user and per-`sid` indexes must not mix. The adapter keeps a hash under `<prefix>:session:<id>` whose TTL is the idle limit capped by the absolute one, plus the sets `<prefix>:sid:<sid>` and `<prefix>:user:<sub>`; every write is one Lua script. Redis must persist (compose runs it with `--appendonly yes`) or a restart logs everyone out. A relational adapter would be a drop-in with `UPDATE ... WHERE id = $1` as its conditional write; it needs an expiry cleanup job or a partial index on `expires_at`, and gains trivial listing and revocation queries.

## Testing

`@auth-stack/auth/testing` is an in-process OpenID Provider served to `openid-client` through its `customFetch` hook: discovery, JWKS, the token endpoint (code exchange with PKCE, refresh with rotation), and the revocation endpoint (RFC 7009; `revocations` records every call, `refuseRevocation()` makes it answer a server error) behave like Zitadel's as far as this package relies on them. `authorize(url, user)` plays the user's login and returns the callback URL; `deny(url)` an error response; `tamperNextIdToken({ nonce | iss | aud | exp })` forces the validation failures; `sign(claims, { typ })` signs any JWT with the OP's key (the bearer tests' access tokens, the sink's logout tokens), and `fetch` serves the matching JWKS to `createBearerVerifier` and to `verifyLogoutToken` too.

```ts
const op = await createFakeOp({ clientId: 'dashboard-web', projectId: 'project-1' });
const client = createOidcClient(config, { fetch: op.fetch, serverMetadata: op.metadata });
```

The `SessionStore` contract (`src/session-store.contract.ts`) runs against both adapters with an injected clock.

## Checks

```sh
pnpm test packages/auth      # unit tests: the client, the bearer verifier, and the logout-token sink against the fake OP, the memory store, the synchronizer token, the headers, the Next.js and Fastify bindings
pnpm test:integration        # the Redis store, and the sink over it, against the compose Redis; reads REDIS_URL from the environment or the root .env
```
