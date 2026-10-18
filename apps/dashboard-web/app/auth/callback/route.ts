import { auth } from '../../../lib/auth';

/**
 * Completes a login (docs/README.md §4.4 step 3): the code is exchanged, the tokens validated, the session created
 * and its cookie set, and the browser lands on the dashboard; any failure is one generic response. The
 * just-in-time provisioning calls of step 4 are ticket 10.
 */
export function GET(request: Request): Promise<Response> {
  return auth().callback(request);
}
