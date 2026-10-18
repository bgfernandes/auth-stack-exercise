import { auth } from '../../../lib/auth';

/** Starts a login (docs/README.md §4.4 step 1): a redirect to Zitadel with the login stash in a signed cookie. */
export function GET(): Promise<Response> {
  return auth().login();
}
