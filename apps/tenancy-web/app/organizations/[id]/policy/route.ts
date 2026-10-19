import { appUrl } from '../../../../lib/auth';
import { getCurrentUserContext, verifyCsrfToken } from '../../../../lib/current-user';
import { log } from '../../../../lib/log';
import { createPolicyHandler } from '../../../../lib/manage-policy';
import { tenancy } from '../../../../lib/tenancy';

/**
 * The policy form's save (ticket 17): `POST /organizations/:id/policy`, same-origin only and with the session's token (docs/README.md §9),
 * sent to `tenancy-api` with the user's token, which enforces `organization#administer` and validates the
 * policy (§9.1), then back to the organization page.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handler()(request, id);
}

let cached: ReturnType<typeof createPolicyHandler> | undefined;

/** Built on first use, like the rest of `lib/`: `next build` evaluates this module with no configuration. */
function handler() {
  cached ??= createPolicyHandler({
    tenancy: tenancy(),
    appUrl: appUrl('/').href,
    userFromRequest: () => getCurrentUserContext(),
    verifyCsrfToken,
    logger: log,
  });
  return cached;
}
