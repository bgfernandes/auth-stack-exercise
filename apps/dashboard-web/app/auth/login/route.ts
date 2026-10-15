import { NextResponse } from 'next/server';
import * as client from 'openid-client';

import { LOGIN_COOKIE, oidcConfiguration, oidcEnv, type LoginStash } from '../../../lib/oidc';

export async function GET(): Promise<NextResponse> {
  const config = await oidcConfiguration();
  const env = oidcEnv();

  const codeVerifier = client.randomPKCECodeVerifier();
  const stash: LoginStash = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier,
  };

  const authorizationUrl = client.buildAuthorizationUrl(config, {
    redirect_uri: env.redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state: stash.state,
    nonce: stash.nonce,
  });

  const response = NextResponse.redirect(authorizationUrl);
  // Spike only: unsigned. Ticket 8 signs the stash and gives it a proper home in packages/auth.
  response.cookies.set(LOGIN_COOKIE, JSON.stringify(stash), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/auth/callback',
    maxAge: 600,
  });
  return response;
}
