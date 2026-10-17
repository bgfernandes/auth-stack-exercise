# `@auth-stack/auth`

The one place OIDC and session details live for the BFFs ([`docs/README.md`](../../docs/README.md) §4.4, §9): an OIDC client over `openid-client` v6 (authorization code with PKCE `S256`, `state` and `nonce` bound to the login attempt, ID-token validation, refresh, RP-initiated logout), the server-side session and its `SessionStore` with in-memory and Redis adapters, an access-token provider that refreshes on demand, cookie and same-origin helpers, and `redact` for logs. The core works on the Fetch API's `Request` and `Response`; `@auth-stack/auth/next` binds it to Next.js route handlers. The bearer half for the APIs (`@auth-stack/auth/fastify`) is ticket 15, the back-channel logout sink ticket 18, and the authentication-context policy helper ticket 24.

## Configuration

`authOptionsFromEnv(process.env, { app })` reads the contract; every value is checked at startup.

| Variable | Meaning |
| --- | --- |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `OIDC_POST_LOGOUT_REDIRECT_URI` | The application bootstrap registered; written to the app's `.local/config/<app>.env` by the bootstrap container |
| `APP_URL` | The app's public URL (also from the handoff file): its scheme decides `Secure` on the cookies, its origin is what `assertSameOrigin` expects |
| `SESSION_SECRET` | Signs the login stash cookie; at least 32 characters (`.env` carries a development value) |
| `REDIS_URL` | The session store (`redis://redis:6379` inside compose, `localhost` from the host) |
| `SESSION_COOKIE_NAME` | Optional; defaults to `<app>_session` (`dashboard_web_session`). Distinct per app: the BFFs share `localtest.me`, and cookies are not isolated by port |

## Usage

```ts
import { Redis } from 'ioredis';

import { authOptionsFromEnv, createRedisSessionStore } from '@auth-stack/auth';
import { createNextAuth } from '@auth-stack/auth/next';

const options = authOptionsFromEnv(process.env, { app: 'dashboard-web' });
const store = createRedisSessionStore(new Redis(options.redisUrl), { prefix: 'dashboard-web' });
export const auth = createNextAuth({ options, store, afterLoginPath: '/dashboard' });

// app/auth/login/route.ts      export const GET = () => auth.login();
// app/auth/callback/route.ts   export const GET = (request: Request) => auth.callback(request);
// app/auth/logout/route.ts     export const POST = (request: Request) => auth.logout(request);
// a server component           const session = await auth.currentSession();
// proxy.ts or a route handler  const session = await auth.sessionFromRequest(request);
// calling an API               const token = await auth.getAccessToken(session); // undefined: send to login
```

`login()` redirects to the authorization endpoint and seals `state`, `nonce`, and the PKCE verifier into a signed cookie scoped to the callback path, valid ten minutes. `callback(request)` verifies the callback against that stash, exchanges the code, validates the tokens, creates the session, sets the session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` over https, `Path=/`, no `Domain`), and redirects to `afterLoginPath`; every failure gets the same generic response (a plain `400`, or what `loginFailed` returns) while the reason is logged through the `logger` option with `redact` applied. The token request always carries the registered redirect URI, never the host the server saw the request on (the standalone Next.js server reports its bind address). `logout(request)` accepts same-origin requests only (`Origin`, falling back to `Sec-Fetch-Site`), deletes the session, clears the cookie, and redirects to the IdP's `end_session_endpoint` with `id_token_hint`, so the IdP session ends too. The session helpers return the live session or `undefined`, and mark it seen at most once a minute.

The core is the same without Next.js:

```ts
import { createAccessTokenProvider, createOidcClient, openStash, sealStash, sessionFromLogin } from '@auth-stack/auth';

const client = createOidcClient(options.oidc); // discovery once per process
const { url, stash } = await client.beginLogin(); // redirect to url; sealStash(stash, secret) into a cookie
const login = await client.completeLogin(callbackUrl, openStash(cookie, secret, Date.now()));
const session = await store.create(sessionFromLogin(login));
const { getAccessToken } = createAccessTokenProvider({ client, store });
```

Failures are `AuthError`s with a `code`: `no_login_in_progress`, `login_expired`, `state_mismatch`, `nonce_mismatch`, `authorization_denied`, `exchange_failed`, `token_invalid`, `refresh_failed`, `forbidden_origin`. The error message never carries a token; log records go through `redact()`, which blanks credential-bearing fields (`accessToken`, `refresh_token`, `cookie`, `authorization`, `password`, ...) at any depth.

`getAccessToken(session)` returns the stored token while it has more than a minute left, otherwise refreshes through the refresh token and writes the rotated pair back with `update`. Concurrent calls for one session share one refresh; a refused refresh re-reads the session in case another process refreshed first, and on `invalid_grant` deletes the session and returns `undefined`, which the caller turns into a login redirect.

## Sessions and stores

A session is `{ id, sub, email, name, sid, accessToken, refreshToken, idToken, accessTokenExpiresAt, authTime, amr, createdAt, lastSeenAt, absoluteExpiresAt }` (timestamps in epoch milliseconds; `sid`, `auth_time`, and `amr` come from the ID token, the evidence the authentication-context policies of §9.1 use). The browser only ever holds the opaque `id`.

`SessionStore` is modelled on the `sessionStore` of Auth0's `nextjs-auth0`: `create`, `get` (applies the idle limit of 30 minutes and the absolute limit of 8 hours; the limits are an option), `touch` and `update` (write only to a session that still exists and report whether they did, so a rolling write or a refresh in flight during a logout never recreates it; no upsert exists), `delete`, `deleteByLogoutToken({ sid, sub })` (with `sid`, the sessions of that IdP session, also matching `sub` when both are given; with `sub` alone, every session of the user), `deleteByUser`, `listByUser`.

Picking a store: `createMemorySessionStore()` for tests and single-process development; `createRedisSessionStore(client, { prefix })` for everything else, where `client` is any `ioredis`-compatible object with `eval`, `hgetall`, `smembers`, and `srem` (the package does not depend on `ioredis`; the app does). Each app passes its own `prefix`, since the BFFs share one Redis and the per-user and per-`sid` indexes must not mix. The adapter keeps a hash under `<prefix>:session:<id>` whose TTL is the idle limit capped by the absolute one, plus the sets `<prefix>:sid:<sid>` and `<prefix>:user:<sub>`; every write is one Lua script. Redis must persist (compose runs it with `--appendonly yes`) or a restart logs everyone out. A relational adapter would be a drop-in with `UPDATE ... WHERE id = $1` as its conditional write; it needs an expiry cleanup job or a partial index on `expires_at`, and gains trivial listing and revocation queries.

## Testing

`@auth-stack/auth/testing` is an in-process OpenID Provider served to `openid-client` through its `customFetch` hook: discovery, JWKS, and the token endpoint (code exchange with PKCE, refresh with rotation) behave like Zitadel's as far as this package relies on them. `authorize(url, user)` plays the user's login and returns the callback URL; `deny(url)` an error response; `tamperNextIdToken({ nonce | iss | aud | exp })` forces the validation failures; `sign(claims)` signs any JWT with the OP's key (bearer tokens for ticket 15, logout tokens for ticket 18).

```ts
const op = await createFakeOp({ clientId: 'dashboard-web', projectId: 'project-1' });
const client = createOidcClient(config, { fetch: op.fetch, serverMetadata: op.metadata });
```

The `SessionStore` contract (`src/session-store.contract.ts`) runs against both adapters with an injected clock.

## Checks

```sh
pnpm test packages/auth      # unit tests: the client against the fake OP, the memory store, the Next.js binding
pnpm test:integration        # the Redis store against the compose Redis; reads REDIS_URL from the environment or the root .env
```
