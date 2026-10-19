/**
 * What the two write routes share (docs/README.md §9): a same-origin `POST` of a form carrying the session's
 * synchronizer token, as the signed-in user,
 * answered with a redirect the browser follows or with the status a replayed `curl` reads. Route handlers
 * rather than Server Actions, so that the enforcement is an endpoint a reviewer can replay. The API is the
 * control: a refusal it answers is mapped here, never pre-empted.
 */
import { assertSameOrigin, CSRF_FIELD } from '@auth-stack/auth';
import { isTenancyClientError, type UserContext } from '@auth-stack/tenancy/client';

import { type AppLogger } from './log';

export interface FormHandlerDeps {
  /** The app's public URL: what the request's `Origin` must match, and the base of the redirects. */
  appUrl: string;
  /** The user behind the request's session cookie, with a live access token; undefined when there is none. */
  userFromRequest: (request: Request) => Promise<UserContext | undefined>;
  /** Whether the posted `csrf_token` is the session's (§9, "CSRF"): the third layer, after the origin check. */
  verifyCsrfToken: (presented: unknown) => Promise<boolean>;
  logger: Pick<AppLogger, 'info' | 'warn'>;
}

export type FormHandler = (request: Request, organizationId: string) => Promise<Response>;

/** The request accepted: who posted it and what. Otherwise the response that ends it. */
export async function acceptForm(
  request: Request,
  deps: FormHandlerDeps,
  rejectedEvent: string,
): Promise<{ user: UserContext; form: FormData } | Response> {
  try {
    assertSameOrigin(request, deps.appUrl);
  } catch (error) {
    deps.logger.warn(rejectedEvent, { reason: error instanceof Error ? error.message : 'origin' });
    return new Response('Forbidden', { status: 403 });
  }
  const user = await deps.userFromRequest(request);
  if (!user) return new Response('Unauthorized', { status: 401 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Not a form at all (a crafted request): the same answer for every organization, so it leaks nothing.
    return new Response('Bad Request', { status: 400 });
  }
  if (!(await deps.verifyCsrfToken(form.get(CSRF_FIELD)))) {
    deps.logger.warn(rejectedEvent, { reason: 'csrf_token_invalid' });
    return new Response('Forbidden', { status: 403 });
  }
  return { user, form };
}

/** A 303 to the organization page, with the outcome for the page to show. */
export function backToOrganization(
  appUrl: string,
  organizationId: string,
  outcome: { saved: string } | { error: string },
): Response {
  const query = 'saved' in outcome ? `saved=${outcome.saved}` : `error=${outcome.error}`;
  return Response.redirect(
    new URL(`/organizations/${encodeURIComponent(organizationId)}?${query}`, appUrl),
    303,
  );
}

/**
 * The API's refusal as the browser should see it: `forbidden` and `not_found` are statuses (§6.5: the page
 * showed no control, so a request that reaches here was crafted), the rules an administrator can run into
 * (`not_a_member`, `last_admin`, `personal_organization`, `invalid_input`) go back to the page as a message.
 * Anything else is an outage, rethrown.
 */
export function refusal(
  error: unknown,
  appUrl: string,
  organizationId: string,
): { response: Response; code: string } {
  if (!isTenancyClientError(error) || error.status >= 500) throw error;
  if (error.code === 'forbidden')
    return { response: new Response('Forbidden', { status: 403 }), code: error.code };
  if (error.code === 'not_found')
    return { response: new Response('Not Found', { status: 404 }), code: error.code };
  if (error.status === 401)
    return { response: new Response('Unauthorized', { status: 401 }), code: error.code };
  return {
    response: backToOrganization(appUrl, organizationId, { error: error.code }),
    code: error.code,
  };
}
