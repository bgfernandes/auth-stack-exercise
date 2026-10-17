/**
 * `@auth-stack/client-scopes`: client authority (docs/README.md §6.7) stored in SpiceDB because the provider
 * has no custom scopes and no consent screen. This package is the whole workaround, kept apart so that it can
 * be deleted as a unit the day the provider puts `scope` in its access tokens: the APIs then pass
 * `fromScopeClaim` from `@auth-stack/auth` instead of `createScopeResolver`, bootstrap stops writing the
 * grants, and the `client` and `api_scope` definitions leave `schema.zed`. Nothing else changes.
 *
 * The grant is `api_scope:<scope with _ for :>#grantee@client:<client_id>`; the resolver answers "which
 * scopes may this client invoke" with one `LookupResources`, cached per client for a minute because client
 * authority changes rarely and bootstrap writes it before the APIs start.
 */
import {
  minimizeLatency,
  ref,
  type Authz,
  type Consistency,
  type ObjectRef,
} from '@auth-stack/authz';

import type { AccessTokenClaims, ScopeResolver } from '@auth-stack/auth';

/** An API scope string as RFC 6749 §3.3 writes it: `<api>:<verb>`, e.g. `documents:write` (§6.7). */
const SCOPE = /^[a-z][a-z0-9]*:[a-z][a-z0-9]*$/;
const OBJECT_ID = /^[a-z][a-z0-9]*_[a-z][a-z0-9]*$/;

/**
 * The `api_scope` object ID for a scope string: `:` becomes `_` because SpiceDB object IDs cannot contain a
 * colon. The one mapping both bootstrap (writing the grants) and the resolver (reading them) use; it is
 * reversible only because the scope grammar has no underscore.
 */
export function scopeObjectId(scope: string): string {
  if (!SCOPE.test(scope)) throw new Error(`invalid API scope: ${JSON.stringify(scope)}`);
  return scope.replace(':', '_');
}

/** The scope string behind an `api_scope` object ID; undefined for an ID the grammar does not produce. */
export function scopeFromObjectId(id: string): string | undefined {
  return OBJECT_ID.test(id) ? id.replace('_', ':') : undefined;
}

export function apiScope(scope: string): ObjectRef<'api_scope'> {
  return ref('api_scope', scopeObjectId(scope));
}

export function client(clientId: string): ObjectRef<'client'> {
  return ref('client', clientId);
}

export interface ScopeResolverOptions {
  /** How long a client's scopes are reused before SpiceDB is asked again; 60 s by default. */
  ttlMs?: number;
  /** `minimizeLatency` by default: grants are written by bootstrap before the APIs start, and change rarely. */
  consistency?: Consistency;
  now?: () => number;
}

export interface CachedScopeResolver extends ScopeResolver {
  /** Drops the cached scopes of one client, or of every client. */
  invalidate(clientId?: string): void;
}

/** The SpiceDB-backed `ScopeResolver` of `@auth-stack/auth`, wired in by each API at startup. */
export function createScopeResolver(
  authz: Authz,
  options: ScopeResolverOptions = {},
): CachedScopeResolver {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  const consistency = options.consistency ?? minimizeLatency;
  const cache = new Map<string, { scopes: ReadonlySet<string>; expiresAt: number }>();
  const pending = new Map<string, Promise<ReadonlySet<string>>>();

  async function lookup(clientId: string): Promise<ReadonlySet<string>> {
    const ids = await authz.lookupResources({
      type: 'api_scope',
      permission: 'invoke',
      subject: client(clientId),
      consistency,
    });
    const scopes = new Set<string>();
    for (const id of ids) {
      const scope = scopeFromObjectId(id);
      if (scope !== undefined) scopes.add(scope);
    }
    return scopes;
  }

  return {
    resolveScopes(claims: AccessTokenClaims) {
      const clientId = claims.client_id;
      const cached = cache.get(clientId);
      if (cached && cached.expiresAt > now()) return Promise.resolve(cached.scopes);
      let inFlight = pending.get(clientId);
      if (!inFlight) {
        inFlight = lookup(clientId)
          .then((scopes) => {
            cache.set(clientId, { scopes, expiresAt: now() + ttlMs });
            return scopes;
          })
          .finally(() => pending.delete(clientId));
        pending.set(clientId, inFlight);
      }
      return inFlight;
    },
    invalidate(clientId) {
      if (clientId === undefined) cache.clear();
      else cache.delete(clientId);
    },
  };
}
