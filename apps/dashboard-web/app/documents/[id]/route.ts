import { appUrl } from '../../../lib/auth';
import { clients } from '../../../lib/clients';
import { getCurrentUserContext, verifyCsrfToken } from '../../../lib/current-user';
import { log } from '../../../lib/log';
import { createDocumentSaver } from '../../../lib/save-document';

/**
 * Saves the edit form (docs/README.md §6.5): `POST /documents/:id`, same-origin only and with the session's token (§9), validated, enforced
 * by `dashboard-api` at full consistency, then back to the dashboard. A route handler rather than a Server Action so
 * that the enforcement is an endpoint a reviewer can replay with `curl`. The edit page lives one segment down
 * because Next.js does not allow a page and a route handler in the same segment.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return saver()(request, id);
}

let cached: ReturnType<typeof createDocumentSaver> | undefined;

/** Built on first use, like the rest of `lib/`: `next build` evaluates this module with no configuration. */
function saver() {
  cached ??= createDocumentSaver({
    documents: clients().documents,
    appUrl: appUrl('/').href,
    userFromRequest: () => getCurrentUserContext(),
    verifyCsrfToken,
    logger: log,
  });
  return cached;
}
