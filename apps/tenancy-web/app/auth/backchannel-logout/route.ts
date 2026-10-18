import { auth } from '../../../lib/auth';

/**
 * The back-channel logout sink (docs/README.md §4.4 step 6): Zitadel posts a logout token here, server to
 * server, when the user's IdP session ends, and the sessions it names are removed from Redis. No cookie, no
 * origin check, never a redirect: the signed token is the request's authentication (`@auth-stack/auth`).
 */
export function POST(request: Request): Promise<Response> {
  return auth().backchannelLogout(request);
}
