import { auth } from '../../../lib/auth';

/**
 * Completes a login (docs/README.md §4.4 step 3): the code is exchanged, the tokens validated, the session created
 * and its cookie set, and the browser lands on the organizations list; any failure is one generic response. The
 * provisioning call of step 4 runs in between (`lib/provisioning.ts`).
 */
export function GET(request: Request): Promise<Response> {
  return auth().callback(request);
}
