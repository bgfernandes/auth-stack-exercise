/**
 * Alice, Acme's admin (docs/README.md §6.3): sees her two organizations, promotes Bob and demotes him back (the
 * acceptance criterion read against the seed, where Bob starts as a member), sets a policy and clears it again
 * so the seeded scenario is as documented after the run, is refused as the last administrator, and finds
 * nothing to manage on her personal organization.
 */
import { test, expect } from '@playwright/test';

import { ACME_MEMBERS, logIn, logOut, memberRows, readSeed, seedPassword } from './stack';

const seed = readSeed();

test('alice manages Acme: roles, the policy, and the last-admin rule', async ({ page }) => {
  await logIn(page, seed.users.alice.email, seedPassword());
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Alice Adams');
  await expect(page.locator('tbody tr').getByRole('link')).toHaveText(['Acme', 'Personal']);

  await page.getByRole('link', { name: 'Acme' }).click();
  await expect(page).toHaveURL(`/organizations/${seed.organization.id}`);
  expect(await memberRows(page)).toEqual(ACME_MEMBERS);

  // Bob to administrator and back; the list reads the change back at once.
  const bob = () => page.getByRole('row', { name: /Bob Baker/ });
  await bob().getByRole('button', { name: 'Make administrator' }).click();
  await expect(page.getByRole('status')).toHaveText('Member list updated.');
  expect(await memberRows(page)).toEqual([
    ACME_MEMBERS[0],
    { ...ACME_MEMBERS[1], role: 'Administrator' },
    ACME_MEMBERS[2],
  ]);
  await bob().getByRole('button', { name: 'Make member' }).click();
  await expect(page.getByRole('status')).toHaveText('Member list updated.');
  expect(await memberRows(page)).toEqual(ACME_MEMBERS);

  // The last administrator cannot demote herself.
  await page
    .getByRole('row', { name: /Alice Adams/ })
    .getByRole('button', { name: 'Make member' })
    .click();
  // The page's own alert; Next.js's route announcer is a second, empty `role="alert"`.
  await expect(page.locator('p[role="alert"]')).toHaveText(
    'An organization keeps at least one administrator. Nothing was changed.',
  );
  expect(await memberRows(page)).toEqual(ACME_MEMBERS);

  // The policy: set, read back, cleared again.
  const mfa = page.getByLabel('Require multi-factor authentication');
  const maxAge = page.getByLabel('Maximum login age, in seconds (empty: no limit)');
  await expect(mfa).not.toBeChecked();
  await expect(maxAge).toHaveValue('');
  await mfa.check();
  await maxAge.fill('600');
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByRole('status')).toHaveText('Policy saved.');
  await expect(mfa).toBeChecked();
  await expect(maxAge).toHaveValue('600');
  await mfa.uncheck();
  await maxAge.fill('');
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByRole('status')).toHaveText('Policy saved.');
  await expect(mfa).not.toBeChecked();
  await expect(maxAge).toHaveValue('');

  // The personal organization has nothing to manage (§5.1).
  await page.goto('/organizations');
  await page.getByRole('link', { name: 'Personal' }).click();
  await expect(page.getByText('Your personal organization')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Members' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save policy' })).toHaveCount(0);

  await logOut(page, seed.users.alice.email);
});
