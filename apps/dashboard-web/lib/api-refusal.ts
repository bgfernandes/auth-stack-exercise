/**
 * What an answer of `dashboard-api` means to this app (docs/README.md §6.5): `401` says the session's token is
 * no longer accepted, so the user logs in again (the session is left to its own expiry); `403 forbidden` says
 * the user may view the document but not edit it; `404` says the document does not exist or the user may not
 * learn that it does. Every other answer, `400 invalid_input` included (the form was validated with the same
 * rule the service enforces, so a disagreement is a bug, not user input), is a failure that surfaces.
 */
import { isDocumentsClientError } from '@auth-stack/documents/client';

export type Refusal = 'unauthenticated' | 'forbidden' | 'not_found';

/** The page state an API refusal maps to, undefined for an error that is not one of the three. */
export function refusalOf(error: unknown): Refusal | undefined {
  if (!isDocumentsClientError(error)) return undefined;
  if (error.status === 401) return 'unauthenticated';
  if (error.status === 403 && error.code === 'forbidden') return 'forbidden';
  if (error.status === 404) return 'not_found';
  return undefined;
}
