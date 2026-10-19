/** Alice, Acme's admin (docs/README.md §6.3): every Acme document, all editable; she edits the Finance one. */
import { test, expect } from '@playwright/test';

import {
  dashboardShows,
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
  // Reloaded inside the lag: on a fresh stack this is her first login, and the workspace it created a moment
  // ago may be missing from the listing for one window (§7.3).
  await dashboardShows(page, [
    row('Acme', 'Finance', 'Payroll', 'edit'),
    row('Acme', 'Marketing', 'Budget', 'edit'),
    row('Acme', 'Marketing', 'Launch plan', 'edit'),
    row('Personal', 'Personal', 'Welcome', 'edit'),
  ]);

  await editAndRestore(page, seed.documents.payroll, marker('alice'));

  await logOut(page, seed.users.alice.email);
});
