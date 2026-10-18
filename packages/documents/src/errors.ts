export type DocumentsErrorCode =
  /** The document does not exist, or the caller may not know that it does (§6.5: `404`, no existence leak). */
  | 'not_found'
  /** The caller may view the document but not do this to it (§6.5: `403`). */
  | 'forbidden'
  /** A share names a user who is not a member of the organization that owns the document (§6.8: `400`). */
  | 'not_a_member';

/** One error type for the service; the web app and, in phase 2, `dashboard-api` map `code` to a status. */
export class DocumentsError extends Error {
  constructor(
    readonly code: DocumentsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentsError';
  }
}

const CODES: readonly string[] = [
  'not_found',
  'forbidden',
  'not_a_member',
] satisfies DocumentsErrorCode[];

/**
 * Whether `error` is a `DocumentsError`, from this copy of the package or another. A bundler can give a Next.js
 * route handler and a server component separate copies of the package while the service they share was built
 * by one of them, so `instanceof` fails across that line; the name and the code do not.
 */
export function isDocumentsError(error: unknown): error is DocumentsError {
  return (
    error instanceof Error &&
    error.name === 'DocumentsError' &&
    'code' in error &&
    typeof error.code === 'string' &&
    CODES.includes(error.code)
  );
}
