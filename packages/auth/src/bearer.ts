/**
 * Bearer verification for the APIs (docs/README.md §4.4, last paragraphs; §6.7): a JWT access token is verified
 * locally against the issuer's JWKS (RS256 only, the algorithm Zitadel signs with: a token naming another
 * algorithm is refused before any key is looked up), with `iss`, `exp` required, and that `aud` contains the
 * project ID, and the subject
 * and client it names become the request's principal. No network call per request beyond the cached JWKS, and
 * the window that leaves (a token the IdP invalidated stays valid until `exp`) is bounded by the 10-minute
 * lifetime. The scope gate on top: `ScopeResolver` turns the token's claims into the client's scopes, and
 * `requireScopes` is the check every route runs before any business logic.
 */
import {
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type RemoteJWKSetOptions,
} from 'jose';

export type JwksFetch = NonNullable<RemoteJWKSetOptions[typeof customFetch]>;

export interface BearerOptions {
  /** What `iss` must be. */
  issuer: string;
  /** What `aud` must contain: the Zitadel project ID, since every API is an application of the one project. */
  audience: string;
  jwksUrl: string;
  /** Seconds of leeway on `exp` and `nbf`; 30 by default. */
  clockToleranceSeconds?: number;
  /** Replaces `fetch` for the JWKS (the tests' fake OP). */
  fetch?: JwksFetch;
  /** Replaces the JWKS lookup entirely. */
  getKey?: JWTVerifyGetKey;
}

/** `bearerOptionsFromEnv` reads the three values bootstrap writes to `apis.env`. */
export function bearerOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): BearerOptions {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`missing environment variable ${name}`);
    return value;
  };
  return {
    issuer: required('OIDC_ISSUER'),
    audience: required('OIDC_PROJECT_ID'),
    jwksUrl: required('OIDC_JWKS_URL'),
  };
}

/**
 * The claims of a verified access token. `client_id` is what RFC 9068 requires and what Zitadel's JWT access
 * tokens carry (no `azp`, no `scope`; verified against a real token on 2026-10-17, ticket 15).
 */
export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  client_id: string;
  /** Present with providers that put the granted scopes in the token; absent with Zitadel. */
  scope?: string;
}

export interface Principal {
  sub: string;
  clientId: string;
  claims: AccessTokenClaims;
}

export type BearerErrorCode = 'missing_token' | 'invalid_token' | 'insufficient_scope';

/** A rejected request; `challenge` is the `WWW-Authenticate` value RFC 6750 §3 prescribes for it. */
export class BearerError extends Error {
  override readonly name = 'BearerError';

  constructor(
    readonly code: BearerErrorCode,
    message: string,
    options: { cause?: unknown; scopes?: string[] } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.scopes = options.scopes ?? [];
  }

  /** The scopes the request needed, for `insufficient_scope`. */
  readonly scopes: string[];

  get status(): 401 | 403 {
    return this.code === 'insufficient_scope' ? 403 : 401;
  }

  get challenge(): string {
    switch (this.code) {
      case 'missing_token':
        return 'Bearer';
      case 'invalid_token':
        return 'Bearer error="invalid_token"';
      case 'insufficient_scope':
        return `Bearer error="insufficient_scope", scope="${this.scopes.join(' ')}"`;
    }
  }
}

export interface BearerVerifier {
  /** The principal behind an `Authorization` header value; throws `BearerError` (`missing_token` or `invalid_token`). */
  verify(authorization: string | undefined): Promise<Principal>;
}

// RFC 6750 §2.1: the scheme is case-insensitive, the credentials are b64token characters.
const AUTHORIZATION = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i;

export function createBearerVerifier(options: BearerOptions): BearerVerifier {
  const getKey =
    options.getKey ??
    createRemoteJWKSet(new URL(options.jwksUrl), {
      ...(options.fetch ? { [customFetch]: options.fetch } : {}),
    });
  const clockTolerance = options.clockToleranceSeconds ?? 30;

  return {
    async verify(authorization) {
      if (!authorization) throw new BearerError('missing_token', 'no Authorization header');
      const match = AUTHORIZATION.exec(authorization.trim());
      if (!match?.[1])
        throw new BearerError('invalid_token', 'Authorization is not a bearer token');
      let payload: JWTPayload;
      let typ: string | undefined;
      try {
        const result = await jwtVerify(match[1], getKey, {
          algorithms: ['RS256'],
          issuer: options.issuer,
          audience: options.audience,
          requiredClaims: ['exp'],
          clockTolerance,
        });
        payload = result.payload;
        typ = result.protectedHeader.typ;
      } catch (error) {
        // Only a verdict on the token is `invalid_token` (RFC 6750 §3.1). A JWKS that cannot be fetched is the
        // API's problem, not the client's, and propagates as a server error so a BFF does not discard a good
        // token and send the user back to login.
        if (
          error instanceof joseErrors.JOSEError &&
          error.code !== 'ERR_JOSE_GENERIC' &&
          error.code !== 'ERR_JWKS_TIMEOUT'
        ) {
          throw new BearerError('invalid_token', 'token verification failed', { cause: error });
        }
        throw error;
      }
      // An ID token of the same issuer passes the checks above (its `aud` carries the project ID too, ticket 3),
      // and accepting one is the pattern `aud` exists to prevent (§9.1). RFC 9068 marks access tokens with
      // `typ: at+jwt`; Zitadel uses `typ: JWT` for both, so the claims decide: `client_id` is required of an
      // access token, `at_hash` and `nonce` only ever appear in an ID token.
      if (typ !== undefined && typ !== 'JWT' && typ !== 'at+jwt') {
        throw new BearerError('invalid_token', `unexpected token type ${typ}`);
      }
      if ('at_hash' in payload || 'nonce' in payload) {
        throw new BearerError('invalid_token', 'an ID token is not an access token');
      }
      if (typeof payload.sub !== 'string' || !payload.sub) {
        throw new BearerError('invalid_token', 'token carries no subject');
      }
      if (typeof payload.client_id !== 'string' || !payload.client_id) {
        throw new BearerError('invalid_token', 'token carries no client_id');
      }
      const claims = payload as AccessTokenClaims;
      return { sub: claims.sub, clientId: claims.client_id, claims };
    },
  };
}

/** Turns a verified token's claims into the client's scopes (§6.7): what the application was granted. */
export interface ScopeResolver {
  resolveScopes(claims: AccessTokenClaims): Promise<ReadonlySet<string>>;
}

/** For providers that put the granted scopes in the access token's `scope` claim (RFC 8693, RFC 9068). */
export const fromScopeClaim: ScopeResolver = {
  resolveScopes(claims) {
    return Promise.resolve(new Set((claims.scope ?? '').split(' ').filter((s) => s !== '')));
  },
};

/** An API scope string, `<api>:<verb>` (§6.7); checked when a route is declared, so a typo fails at startup. */
export const SCOPE_PATTERN = /^[a-z][a-z0-9]*:[a-z][a-z0-9]*$/;

export function assertScopeStrings(scopes: readonly string[]): void {
  for (const scope of scopes) {
    if (!SCOPE_PATTERN.test(scope)) throw new Error(`invalid API scope: ${JSON.stringify(scope)}`);
  }
}

/** The scope gate: every required scope must be among the client's; otherwise `insufficient_scope` (403). */
export async function requireScopes(
  principal: Principal,
  resolver: ScopeResolver,
  required: readonly string[],
): Promise<void> {
  const granted = await resolver.resolveScopes(principal.claims);
  const missing = required.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw new BearerError('insufficient_scope', `missing scope ${missing.join(' ')}`, {
      scopes: [...required],
    });
  }
}
