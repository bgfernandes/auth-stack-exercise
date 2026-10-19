/**
 * Logout revokes the refresh token at Zitadel (RFC 7009; the logout of `@auth-stack/auth/next`), proven at the
 * token endpoint rather than in the app's log: Alice logs in, her refresh token is read from the session the
 * app stored in Redis, she logs out through the app's form, and the token is presented to Zitadel's token
 * endpoint, which must refuse it. The logout request is the form's own POST, sent without following its
 * redirect, so the IdP session is still alive when the token is tried and the refusal can only be the
 * revocation's; the redirect to `end_session` is followed afterwards, so nothing is left behind. The positive
 * control proves the token read from Redis is usable: logged in and not out, the same call succeeds. The Node
 * side calls Zitadel directly and trusts the stack's development CA, as a browser would not (playwright.config).
 */
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { parseEnv } from 'node:util';

import { test, expect, type Page } from '@playwright/test';
import { Redis } from 'ioredis';

import { BASE_URL, csrfToken, logIn, logOut, readSeed, seedPassword } from './stack';

/** The repository root: this file is apps/dashboard-web/e2e/revocation.spec.ts. */
const ROOT = new URL('../../../', import.meta.url);
/** Redis as compose publishes it, on the loopback interface; the apps reach it as `redis` inside the network. */
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379';
/** The key prefix dashboard-web gives its store (apps/dashboard-web/lib/auth.ts). */
const PREFIX = 'dashboard-web';

const seed = readSeed();
const handoff = parseEnv(readFileSync(new URL('.local/config/dashboard-web.env', ROOT), 'utf8'));
const issuer = handoff.OIDC_ISSUER as string;
const clientId = handoff.OIDC_CLIENT_ID as string;
const ca = readFileSync(new URL('.local/tls/ca.crt', ROOT));

let redis: Redis;
test.beforeAll(() => {
  redis = new Redis(REDIS_URL);
});
test.afterAll(() => redis.quit());

/** The refresh token of Alice's newest session in dashboard-web's store, through its `user:<sub>` index. */
async function refreshTokenOf(sub: string): Promise<string> {
  const ids = await redis.smembers(`${PREFIX}:user:${sub}`);
  const sessions = await Promise.all(ids.map((id) => redis.hgetall(`${PREFIX}:session:${id}`)));
  const newest = sessions
    .filter((hash) => hash.refreshToken !== undefined)
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0];
  if (!newest?.refreshToken)
    throw new Error(`no session with a refresh token under ${PREFIX}:user:${sub}`);
  return newest.refreshToken;
}

interface TokenResponse {
  status: number;
  body: Record<string, unknown>;
}

/** The refresh-token grant (RFC 6749 §6) at Zitadel's token endpoint, as the public client would send it. */
function refreshAtZitadel(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  }).toString();
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      `${issuer}/oauth/v2/token`,
      {
        method: 'POST',
        ca,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
          });
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

/** The logout form's own POST, its redirect not followed: the app's logout ran, the IdP session has not ended. */
async function postLogout(page: Page): Promise<string> {
  const response = await page.request.post('/auth/logout', {
    form: { csrf_token: await csrfToken(page) },
    headers: { origin: BASE_URL },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  const location = response.headers().location;
  expect(location).toMatch(new RegExp(`^${issuer}/`));
  return location as string;
}

test('a refresh token is refused at Zitadel once alice has logged out of the app', async ({
  page,
}) => {
  await logIn(page, seed.users.alice.email, seedPassword());
  const refreshToken = await refreshTokenOf(seed.users.alice.id);

  const endSession = await postLogout(page);
  // RFC 6749 §5.2 prescribes `invalid_grant` for a revoked refresh token; Zitadel v4.19.4 answers
  // `invalid_request`, with the description of its revoked-session check, where a token it cannot decrypt gets
  // `Errors.User.RefreshToken.Invalid`. The description is asserted so the refusal is the revocation's and not
  // a malformed request's; the positive control below sends the same request and is honoured.
  const refused = await refreshAtZitadel(refreshToken);
  expect(refused.status).toBe(400);
  expect(refused.body).toEqual({
    error: 'invalid_request',
    error_description: 'Errors.OIDCSession.RefreshTokenInvalid',
  });

  // The browser follows the redirect the form would have followed, so the IdP session ends as in any logout.
  await page.goto(endSession);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Log in' })).toBeVisible();
});

test('the same refresh token is honoured while alice is logged in: the token read from Redis is usable', async ({
  page,
}) => {
  await logIn(page, seed.users.alice.email, seedPassword());
  const refreshToken = await refreshTokenOf(seed.users.alice.id);

  const honoured = await refreshAtZitadel(refreshToken);
  expect(honoured.status).toBe(200);
  expect(typeof honoured.body.access_token).toBe('string');

  // Zitadel rotated the refresh token, so the one the session still holds is stale; the logout's revocation of
  // it is logged and ignored, and the logout ends both sessions as always.
  await logOut(page, seed.users.alice.email);
});
