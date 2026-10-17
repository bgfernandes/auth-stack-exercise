import { ref, type ObjectRef } from './vocabulary';

/** An API scope string as RFC 6749 §3.3 writes it: `<api>:<verb>`, e.g. `documents:write` (docs/README.md §6.7). */
const SCOPE = /^[a-z][a-z0-9]*:[a-z][a-z0-9]*$/;

/**
 * The `api_scope` object ID for a scope string: `:` becomes `_` because SpiceDB object IDs cannot contain a colon.
 * The one mapping both bootstrap (writing the grants) and the scope resolver (looking them up) use.
 */
export function scopeObjectId(scope: string): string {
  if (!SCOPE.test(scope)) throw new Error(`invalid API scope: ${JSON.stringify(scope)}`);
  return scope.replace(':', '_');
}

export function apiScope(scope: string): ObjectRef<'api_scope'> {
  return ref('api_scope', scopeObjectId(scope));
}
