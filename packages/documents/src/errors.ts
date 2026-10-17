export type DocumentsErrorCode =
  /** The document does not exist, or the caller may not know that it does (§6.5: `404`, no existence leak). */
  | 'not_found'
  /** The caller may view the document but not edit it (§6.5: `403`). */
  | 'forbidden';

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
