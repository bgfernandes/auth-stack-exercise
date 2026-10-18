/**
 * Carol, the reviewer's user (docs/README.md §6.3): Acme member, Marketing viewer, "Launch plan" shared to her
 * directly, so her dashboard shows all three states at once: editable, read-only, and absent.
 */
import { test, expect } from '@playwright/test';

import {
  dashboardRows,
  editAndRestore,
  logIn,
  logOut,
  marker,
  readSeed,
  row,
  seedPassword,
} from './stack';

const seed = readSeed();

test('carol logs in, sees the three states, edits Launch plan, is read-only on Budget, logs out', async ({
  page,
}) => {
  await logIn(page, seed.users.carol.email, seedPassword());
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Carol Clark');
  expect(await dashboardRows(page)).toEqual([
    row('Acme', 'Marketing', 'Budget', 'read-only'),
    row('Acme', 'Marketing', 'Launch plan', 'edit'),
    row('Personal', 'Personal', 'Welcome', 'edit'),
  ]);

  await editAndRestore(page, seed.documents['launch-plan'], marker('carol'));

  // Read-only: the edit page of a document she may only view is the read-only page, with no form (§6.5).
  await page.goto(`/documents/${seed.documents.budget.id}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Read-only');
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to the dashboard' }).click();
  await expect(page).toHaveURL('/dashboard');

  await logOut(page, seed.users.carol.email);
});
