/**
 * The request interceptor (Next.js 16's `proxy`, on the Node runtime): a request under `/organizations` with no
 * live session is sent to the login before any page runs. The pages and the route handlers check again when
 * they read the session, so this is the early exit, not the only gate.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { appUrl, auth } from './lib/auth';

export const config = { matcher: ['/organizations/:path*'] };

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (await auth().sessionFromRequest(request)) return NextResponse.next();
  // A form posted after the session ended is sent on as a GET (303); a 307 would repeat the POST on the login.
  return NextResponse.redirect(appUrl('/auth/login'), request.method === 'GET' ? 307 : 303);
}
