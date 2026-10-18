/**
 * The request interceptor (Next.js 16's `proxy`, on the Node runtime): a request under `/dashboard` with no live
 * session is sent to the login before any page runs. The pages check again when they read the session, so this
 * is the early exit, not the only gate.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { appUrl, auth } from './lib/auth';

export const config = { matcher: ['/dashboard/:path*'] };

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (await auth().sessionFromRequest(request)) return NextResponse.next();
  return NextResponse.redirect(appUrl('/auth/login'));
}
