/**
 * The documents domain as the pages use it, acting as the signed-in user (docs/README.md §6.5): every call an
 * HTTP request to `dashboard-api` with the user's access token, which goes from the session into the user
 * context here and nowhere near a component. The API's refusals become the pages' states (`lib/api-refusal.ts`);
 * anything else surfaces.
 */
import { type DocumentSummary, type VisibleDocument } from '@auth-stack/documents/client';

import { refusalOf } from './api-refusal';
import { clients } from './clients';
import { getCurrentUserContext } from './current-user';

/** Every document the user may view, with the "Edit" hint decided; undefined when there is no usable session. */
export async function listDocuments(): Promise<VisibleDocument[] | undefined> {
  const user = await getCurrentUserContext();
  if (!user) return undefined;
  try {
    return await clients().documents.listVisibleDocuments(user);
  } catch (error) {
    if (refusalOf(error) === 'unauthenticated') return undefined;
    throw error;
  }
}

export type EditState =
  | { state: 'document'; document: DocumentSummary }
  /** The user may view the document but not edit it (§6.5: forbidden). */
  | { state: 'forbidden' }
  /** The document does not exist, or the user may not learn that it does (§6.5: not found). */
  | { state: 'not_found' }
  | { state: 'unauthenticated' };

/** The row for the edit form, checked by the API at least as fresh as its token (§7.3), or why it cannot be shown. */
export async function documentForEdit(id: string): Promise<EditState> {
  const user = await getCurrentUserContext();
  if (!user) return { state: 'unauthenticated' };
  try {
    return { state: 'document', document: await clients().documents.getDocumentForEdit(user, id) };
  } catch (error) {
    const state = refusalOf(error);
    if (state) return { state };
    throw error;
  }
}
