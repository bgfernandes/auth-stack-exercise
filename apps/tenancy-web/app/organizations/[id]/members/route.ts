import { appUrl } from '../../../../lib/auth';
import { getCurrentUserContext, verifyCsrfToken } from '../../../../lib/current-user';
import { log } from '../../../../lib/log';
import { createMembershipHandler } from '../../../../lib/manage-members';
import { tenancy } from '../../../../lib/tenancy';

/**
 * A role change or a removal from the member list (ticket 17): `POST /organizations/:id/members`, same-origin
 * only and with the session's token (docs/README.md §9), sent to `tenancy-api` with the user's token, which enforces `organization#administer`
 * and the rules of §6.8, then back to the organization page.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handler()(request, id);
}

let cached: ReturnType<typeof createMembershipHandler> | undefined;

/** Built on first use, like the rest of `lib/`: `next build` evaluates this module with no configuration. */
function handler() {
  cached ??= createMembershipHandler({
    tenancy: tenancy(),
    appUrl: appUrl('/').href,
    userFromRequest: () => getCurrentUserContext(),
    verifyCsrfToken,
    logger: log,
  });
  return cached;
}
