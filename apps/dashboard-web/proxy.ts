/**
 * The request interceptor (Next.js 16's `proxy`, on the Node runtime), two jobs. Every response gets the
 * security headers of docs/README.md §9, with the nonce of its policy minted here and handed to the page, so
 * Next.js stamps it on its own scripts; the matcher leaves out the static assets and the prefetches, which need
 * no headers. A request under `/dashboard` or `/documents` with no live session is sent to the login before
 * any page runs; the pages and the write routes check again when they read the session, so this is the early
 * exit, not the only gate (a prefetch skipping it is harmless for the same reason).
 */
import { NextResponse, type NextRequest } from 'next/server';

import { appUrl, auth } from './lib/auth';

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

const PROTECTED = /^\/(dashboard|documents)(\/|$)/;

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const secured = auth().securityHeaders(request);
  if (!PROTECTED.test(request.nextUrl.pathname) || (await auth().sessionFromRequest(request)))
    return secured.next();
  // A form posted after the session ended is sent on as a GET (303); a 307 would repeat the POST on the login.
  return secured.apply(
    NextResponse.redirect(appUrl('/auth/login'), request.method === 'GET' ? 307 : 303),
  );
}
