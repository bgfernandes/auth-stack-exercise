/**
 * The documents domain as the pages use it, acting as the signed-in user (docs/README.md §6.5). In phase 1 the
 * service runs in-process on the app's own connections; phase 2 turns these bodies into HTTP calls to
 * `dashboard-api` with the user's access token and the pages stay as they are. The token goes from the session
 * into the user context here and nowhere near a component.
 */
import { fullyConsistent } from '@auth-stack/authz';
import { type VisibleDocument } from '@auth-stack/documents';

import { getCurrentUserContext } from './current-user';
import { services } from './services';

/** Every document the user may view, with the "Edit" hint decided; undefined when there is no usable session. */
export async function listDocuments(): Promise<VisibleDocument[] | undefined> {
  const user = await getCurrentUserContext();
  if (!user) return undefined;
  // Phase 1 lists at full consistency (ticket 11); ticket 21 moves listings to `minimize_latency` (§7.3).
  return services().documents.listVisibleDocuments(user, fullyConsistent);
}
