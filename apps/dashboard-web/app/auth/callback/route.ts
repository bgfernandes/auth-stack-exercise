import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import * as client from 'openid-client';

import {
  CLAIMS_COOKIE,
  LOGIN_COOKIE,
  oidcConfiguration,
  oidcEnv,
  type LoginStash,
} from '../../../lib/oidc';

export async function GET(request: Request): Promise<NextResponse> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(LOGIN_COOKIE)?.value;
  if (!raw) {
    return new NextResponse('Login failed: no login in progress.', { status: 400 });
  }
  const stash = JSON.parse(raw) as LoginStash;

  const config = await oidcConfiguration();
  // openid-client sends the callback URL minus its query as redirect_uri, so it must be the registered public
  // URL, not whatever host the server saw the request on.
  const callbackUrl = new URL(oidcEnv().redirectUri);
  callbackUrl.search = new URL(request.url).search;
  console.info('callback received on host', new URL(request.url).host);

  let claims: client.IDToken | undefined;
  try {
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: stash.codeVerifier,
      expectedState: stash.state,
      expectedNonce: stash.nonce,
    });
    claims = tokens.claims();
  } catch (error) {
    // The spike logs the reason; the real callback (ticket 8) maps failures to a generic page.
    const detail =
      error instanceof client.ResponseBodyError
        ? `${error.error}: ${error.error_description ?? ''}`
        : error instanceof Error
          ? error.message
          : String(error);
    console.error('authorization code grant failed:', detail);
    return new NextResponse('Login failed.', { status: 400 });
  }
  if (!claims) {
    return new NextResponse('Login failed: no ID token.', { status: 400 });
  }

  const response = NextResponse.redirect(new URL('/', oidcEnv().redirectUri));
  response.cookies.delete(LOGIN_COOKIE);
  // Spike only: the claims ride in a cookie so the page can print them. There is no session yet (ticket 8).
  response.cookies.set(CLAIMS_COOKIE, JSON.stringify(claims), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
  return response;
}
