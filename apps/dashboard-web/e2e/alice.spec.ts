/** Alice, Acme's admin (docs/README.md §6.3): every Acme document, all editable; she edits the Finance one. */
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

test('alice logs in, sees every Acme document editable, edits Payroll, logs out', async ({
  page,
}) => {
  await logIn(page, seed.users.alice.email, seedPassword());
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Alice Adams');
  // Exact at once, also on a fresh stack where this is her first login: the landing names the workspace the
  // login created, and the listing is at least as fresh as it (§6.4, §7.3).
  expect(await dashboardRows(page)).toEqual([
    row('Acme', 'Finance', 'Payroll', 'edit'),
    row('Acme', 'Marketing', 'Budget', 'edit'),
    row('Acme', 'Marketing', 'Launch plan', 'edit'),
    row('Personal', 'Personal', 'Welcome', 'edit'),
  ]);

  await editAndRestore(page, seed.documents.payroll, marker('alice'));

  await logOut(page, seed.users.alice.email);
});
