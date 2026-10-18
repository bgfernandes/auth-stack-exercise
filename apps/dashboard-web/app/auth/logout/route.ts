import { auth } from '../../../lib/auth';

/**
 * Ends the session (docs/README.md §4.4 step 5): same-origin `POST` only (§9, CSRF), then the session is deleted,
 * the cookie cleared, and the browser sent to Zitadel's end-session endpoint so the IdP session ends too.
 */
export function POST(request: Request): Promise<Response> {
  return auth().logout(request);
}
