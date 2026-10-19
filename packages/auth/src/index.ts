/**
 * `@auth-stack/auth`: the framework-agnostic core of the platform's authentication (docs/README.md §4.4). For
 * the BFFs: the OIDC client, the session and its store with the in-memory and Redis adapters, the access-token
 * provider, the cookie and same-origin helpers, and `redact` for logs; `@auth-stack/auth/next` binds them to
 * Next.js route handlers. For the APIs: bearer verification and the scope gate (§6.7), bound to Fastify by
 * `@auth-stack/auth/fastify`. The back-channel logout sink (`handleBackchannelLogout`, over the OIDC client's
 * `verifyLogoutToken`) is bound by the Next.js adapter too, as is the synchronizer token of the forms (`csrfTokenOf`,
 * `verifyCsrfToken`, §9). The authentication-context policy helper is ticket 24.
 */
export {
  createAccessTokenProvider,
  REFRESH_MARGIN_MS,
  type AccessTokenProvider,
  type AccessTokenProviderOptions,
} from './access-token';
export { handleBackchannelLogout, type BackchannelLogoutOptions } from './backchannel-logout';
export {
  assertScopeStrings,
  BearerError,
  bearerOptionsFromEnv,
  createBearerVerifier,
  fromScopeClaim,
  requireScopes,
  SCOPE_PATTERN,
  type AccessTokenClaims,
  type BearerErrorCode,
  type BearerOptions,
  type BearerVerifier,
  type JwksFetch,
  type Principal,
  type ScopeResolver,
} from './bearer';
export {
  assertSameOrigin,
  cookieAttributes,
  readCookie,
  serializeCookie,
  type CookieAttributeOptions,
  type CookieAttributes,
} from './cookies';
export { CSRF_FIELD, csrfTokenOf, verifyCsrfToken } from './csrf';
export { authOptionsFromEnv, type AuthEnvOptions, type AuthOptions } from './env';
export { AuthError, type AuthErrorCode } from './errors';
export {
  BACKCHANNEL_LOGOUT_EVENT,
  createOidcClient,
  DEFAULT_SCOPE,
  oauthErrorOf,
  type IdentityClaims,
  type LoginResult,
  type OidcClient,
  type OidcClientConfig,
  type OidcClientOptions,
  type OidcFetch,
  type TokenSet,
} from './oidc';
export { redact, type AuthLogger } from './redact';
export {
  DEFAULT_SESSION_LIMITS,
  isExpired,
  newSessionId,
  remainingSeconds,
  sessionFromLogin,
  type LogoutTokenClaims,
  type NewSession,
  type Session,
  type SessionLimits,
  type SessionPatch,
  type SessionStore,
  type SessionStoreOptions,
} from './session';
export {
  MIN_SECRET_LENGTH,
  openStash,
  sealStash,
  STASH_LIFETIME_SECONDS,
  type LoginStash,
} from './stash';
export { createMemorySessionStore } from './stores/memory';
export {
  createRedisSessionStore,
  type RedisLike,
  type RedisSessionStoreOptions,
} from './stores/redis';
