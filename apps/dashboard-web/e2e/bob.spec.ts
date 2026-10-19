/** Bob, Acme member and Marketing editor (docs/README.md §6.3): Marketing editable, Finance absent. */
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

test('bob logs in, sees Marketing editable and no Finance, edits Budget, logs out', async ({
  page,
}) => {
  await logIn(page, seed.users.bob.email, seedPassword());
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Bob Baker');
  // Exact at once, a first login included: the landing names the workspace it created (§6.4, §7.3).
  expect(await dashboardRows(page)).toEqual([
    row('Acme', 'Marketing', 'Budget', 'edit'),
    row('Acme', 'Marketing', 'Launch plan', 'edit'),
    row('Personal', 'Personal', 'Welcome', 'edit'),
  ]);

  await editAndRestore(page, seed.documents.budget, marker('bob'));

  // The Finance document is not his to see: the edit page answers as if it did not exist (§6.5).
  const payroll = await page.goto(`/documents/${seed.documents.payroll.id}/edit`);
  expect(payroll?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not found');
  await page.goto('/dashboard');

  await logOut(page, seed.users.bob.email);
});
