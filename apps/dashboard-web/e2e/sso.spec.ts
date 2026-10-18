/**
 * Single sign-on and single sign-out between the two web apps (docs/README.md §4.4; ticket 20). Bob logs in
 * here, opens tenancy-web, and is signed in without a prompt: its login goes through Zitadel's authorization
 * endpoint like any other, and the login UI, finding the IdP session in its cookie, sends him straight back.
 * He logs out on tenancy-web, which ends the IdP session (step 5), and Zitadel posts a logout token to this
 * app's back-channel sink (step 6), so his next request here goes to the login, where Zitadel asks for his
 * password again. The delivery is asynchronous to the browser's redirect (observed: this app's session was
 * still live 30 ms after tenancy-web's landing page showed, and gone 100 ms later), so the spec waits for it
 * with a bound of seconds. Nothing else ends a session within that bound (the store's idle expiry is thirty
 * minutes, and nothing re-validates a session on an interval), so a redirect inside it proves the sink. Bob,
 * because no other spec edits as him; this one changes no data.
 */
import { test, expect } from '@playwright/test';

import { BASE_URL, logIn, navigations, readSeed, seedPassword, TENANCY_WEB_URL } from './stack';

const seed = readSeed();

test('bob signs in once for both apps, and out of both from tenancy-web', async ({ page }) => {
  await logIn(page, seed.users.bob.email, seedPassword());
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Bob Baker');

  // Single sign-on: tenancy-web's login lands without a prompt. On the way, the browser passes through the
  // authorization endpoint and the login UI's entry page, which continues the IdP session; never the login
  // name, the password, or the account picker.
  const visited = navigations(page);
  await page.goto(`${TENANCY_WEB_URL}/auth/login`);
  await page.waitForURL(`${TENANCY_WEB_URL}/organizations`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Bob Baker');
  expect(idpPages(visited)).toEqual(['/oauth/v2/authorize', '/ui/v2/login/login']);

  // Single sign-out, from the other app: its logout ends the IdP session, and Zitadel's logout token reaches
  // this app's sink after the browser is back on tenancy-web's landing page, so the first poll may still find
  // the session live.
  const header = page.getByRole('navigation');
  await header.getByRole('button', { name: 'Log out' }).click();
  await expect(header.getByRole('link', { name: 'Log in' })).toBeVisible();
  await expect
    .poll(async () => (await page.request.get('/dashboard', { maxRedirects: 0 })).status(), {
      message: 'dashboard-web still has the session: the back-channel logout did not arrive',
      timeout: 5_000,
    })
    .toBe(307);

  // The next request goes to the login, and the IdP session is gone too: Zitadel's account picker lists the
  // ended session, and choosing it asks for the password (what logOut in ./stack asserts after a logout here).
  await page.goto('/dashboard');
  await page.getByRole('button', { name: seed.users.bob.email }).click();
  await expect(page.getByLabel('Password')).toBeVisible();
});

/** The paths visited on the identity provider, in order: every navigation to neither web app. */
function idpPages(urls: string[]): string[] {
  return urls
    .filter((url) => !url.startsWith(BASE_URL) && !url.startsWith(TENANCY_WEB_URL))
    .map((url) => new URL(url).pathname);
}
