/**
 * `@auth-stack/auth`: the framework-agnostic core of the BFFs' authentication (docs/README.md §4.4): the OIDC
 * client, the session and its store with the in-memory and Redis adapters, the access-token provider, the cookie
 * and same-origin helpers, and `redact` for logs. `@auth-stack/auth/next` binds it to Next.js route handlers.
 * The bearer half for the APIs (`@auth-stack/auth/fastify`) is ticket 15; the back-channel logout sink is
 * ticket 18; the authentication-context policy helper is ticket 24.
 */
export {
  createAccessTokenProvider,
  REFRESH_MARGIN_MS,
  type AccessTokenProvider,
  type AccessTokenProviderOptions,
} from './access-token';
export {
  assertSameOrigin,
  cookieAttributes,
  readCookie,
  serializeCookie,
  type CookieAttributeOptions,
  type CookieAttributes,
} from './cookies';
export { authOptionsFromEnv, type AuthEnvOptions, type AuthOptions } from './env';
export { AuthError, type AuthErrorCode } from './errors';
export {
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
