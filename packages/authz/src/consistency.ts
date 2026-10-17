/**
 * The consistency a call runs at (docs/README.md §7). Every helper takes one explicitly: there is no default,
 * so the level chosen for an operation is visible at the call site and in the audit log later.
 */
export type Consistency =
  /** The cached snapshot, possibly stale by one quantization window: listings. */
  | { readonly level: 'minimize_latency' }
  /** A snapshot no older than the token, which content reads carry from their row. */
  | { readonly level: 'at_least_as_fresh'; readonly token: ZedToken }
  /** The head revision, bypassing the cache: write-path checks and relationship changes. */
  | { readonly level: 'fully_consistent' };

/** An opaque revision marker, as the string SpiceDB returns; stored with content as text (§7.3). */
export type ZedToken = string;

export const minimizeLatency: Consistency = { level: 'minimize_latency' };
export const fullyConsistent: Consistency = { level: 'fully_consistent' };

export function atLeastAsFresh(token: ZedToken): Consistency {
  if (!token)
    throw new Error(
      'atLeastAsFresh needs a ZedToken; a row without one must be read fully consistent',
    );
  return { level: 'at_least_as_fresh', token };
}
