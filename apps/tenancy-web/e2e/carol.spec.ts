/**
 * Carol, an Acme member (docs/README.md §6.3): sees the member list, the share picker's source (§6.8), with no
 * controls and the policy as text; and the controls' absence is a hint, the API is the control: her session
 * posting the changes directly, the way a crafted request would, with the session's synchronizer token as a
 * page rendered it, is refused on the server; without the token, or from another origin, before any lookup
 * (§9, "CSRF").
 */
import { test, expect } from '@playwright/test';

import {
  ACME_MEMBERS,
  BASE_URL,
  csrfToken,
  logIn,
  memberRows,
  readSeed,
  seedPassword,
} from './stack';

const seed = readSeed();

test('carol sees the members and no controls, and her crafted posts are refused', async ({
  page,
}) => {
  await logIn(page, seed.users.carol.email, seedPassword());
  await page.getByRole('link', { name: 'Acme' }).click();
  await expect(page).toHaveURL(`/organizations/${seed.organization.id}`);
  expect(await memberRows(page)).toEqual(ACME_MEMBERS);
  await expect(page.getByRole('button', { name: /Make|Remove/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save policy' })).toHaveCount(0);
  await expect(page.getByText('No sign-in floors are set.')).toBeVisible();

  const origin = { origin: BASE_URL };
  const csrf_token = await csrfToken(page);
  const promote = await page.request.post(`/organizations/${seed.organization.id}/members`, {
    form: { member_id: seed.users.carol.id, role: 'admin', csrf_token },
    headers: origin,
    maxRedirects: 0,
  });
  expect(promote.status()).toBe(403);
  const policy = await page.request.post(`/organizations/${seed.organization.id}/policy`, {
    form: { require_mfa: 'on', csrf_token },
    headers: origin,
    maxRedirects: 0,
  });
  expect(policy.status()).toBe(403);
  const unknown = await page.request.post(
    '/organizations/00000000-0000-4000-8000-000000000000/policy',
    { form: { csrf_token }, headers: origin, maxRedirects: 0 },
  );
  expect(unknown.status()).toBe(404);
  const noToken = await page.request.post(`/organizations/${seed.organization.id}/policy`, {
    form: { require_mfa: 'on' },
    headers: origin,
    maxRedirects: 0,
  });
  expect(noToken.status()).toBe(403);
  const crossOrigin = await page.request.post(`/organizations/${seed.organization.id}/policy`, {
    form: {},
    headers: { origin: 'http://evil.example' },
    maxRedirects: 0,
  });
  expect(crossOrigin.status()).toBe(403);

  await page.reload();
  expect(await memberRows(page)).toEqual(ACME_MEMBERS);
  await expect(page.getByText('No sign-in floors are set.')).toBeVisible();
});
