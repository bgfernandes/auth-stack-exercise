/**
 * Removes credentials from a structured log record before it is written (docs/README.md §9, "Logging"): every
 * log call of the package, and of the apps when they log anything of this package's, passes its fields through
 * `redact`. Keys are matched by name, case-insensitively, at any depth; the value is replaced, the key is kept,
 * so a record still says that a token was present.
 */
const REDACTED = '[redacted]';

const SENSITIVE_KEY =
  /^(access_?token|refresh_?token|id_?token|token|session_?id|sid|session|cookie|set-cookie|authorization|password|secret|code|code_?verifier|state|nonce)$/i;

export function redact<T>(value: T): T {
  return redactValue(value, 0) as T;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item, depth + 1);
  }
  return out;
}

/** The shape of the logger a host hands to the package; `fields` are already redacted when it is called. */
export interface AuthLogger {
  warn(event: string, fields?: Record<string, unknown>): void;
}
