/**
 * One JSON object per line, so `docker compose logs bootstrap` is grep-able and a log shipper can parse it.
 * Callers pass identifiers and names only: never a token, a password, or a whole API response.
 */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), level: 'info', event, ...fields }));
}

export function logError(
  event: string,
  error: unknown,
  fields: Record<string, unknown> = {},
): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({ time: new Date().toISOString(), level: 'error', event, message, ...fields }),
  );
}
