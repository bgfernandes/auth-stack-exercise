import { appUrl } from '../../../../lib/auth';
import { clients } from '../../../../lib/clients';
import { getCurrentUserContext } from '../../../../lib/current-user';
import { log } from '../../../../lib/log';
import { createDocumentSharer } from '../../../../lib/share-document';

/**
 * Saves the share form (docs/README.md §6.8): `POST /documents/:id/shares`, same-origin only (§9), the set
 * replaced by `dashboard-api` at full consistency, then back to the dashboard. A route handler rather than a
 * Server Action, like the save route, so that the enforcement is an endpoint a reviewer can replay with `curl`.
 * The share page lives at `/documents/[id]/share`, one segment apart, as the edit page does from its route.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return sharer()(request, id);
}

let cached: ReturnType<typeof createDocumentSharer> | undefined;

/** Built on first use, like the rest of `lib/`: `next build` evaluates this module with no configuration. */
function sharer() {
  cached ??= createDocumentSharer({
    documents: clients().documents,
    appUrl: appUrl('/').href,
    userFromRequest: () => getCurrentUserContext(),
    logger: log,
  });
  return cached;
}
