/**
 * Sharing from the dashboard (docs/README.md §6.8) and the listing's lag (§7.3) in the browser: Alice shares
 * Payroll with Bob as a viewer; Bob, in a browser context of his own, sees it on his dashboard once the listing
 * catches up, read-only, inside the bound a listing may lag; Alice takes it back; Bob's edit page refuses at
 * once, since the row's token postdates the removal, and his dashboard loses the row inside the bound. Alice's
 * own dashboard, landed on with the row she shared, is exact at once (§7.3: the writer's own write). Payroll
 * ends with no direct share, as the seed left it, whatever happens in between.
 */
import { test, expect } from '@playwright/test';

import {
  BASE_URL,
  csrfToken,
  dashboardRows,
  dashboardShows,
  logIn,
  logOut,
  readSeed,
  row,
  seedPassword,
} from './stack';

const seed = readSeed();
const payroll = seed.documents.payroll;

const alicesRows = [
  row('Acme', 'Finance', 'Payroll', 'edit'),
  row('Acme', 'Marketing', 'Budget', 'edit'),
  row('Acme', 'Marketing', 'Launch plan', 'edit'),
  row('Personal', 'Personal', 'Welcome', 'edit'),
];

const bobsRows = (payrollAccess?: 'read-only') => [
  ...(payrollAccess ? [row('Acme', 'Finance', 'Payroll', payrollAccess)] : []),
  row('Acme', 'Marketing', 'Budget', 'edit'),
  row('Acme', 'Marketing', 'Launch plan', 'edit'),
  row('Personal', 'Personal', 'Welcome', 'edit'),
];

test('alice shares Payroll with Bob, who sees it read-only once the listing catches up, then takes it back', async ({
  page,
  browser,
}) => {
  await logIn(page, seed.users.alice.email, seedPassword());
  const bob = await browser.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
  const bobPage = await bob.newPage();
  try {
    // "Share" on the row is the hint for her `document#share`; the page lists Acme's other members.
    await page
      .getByRole('row', { name: payroll.name })
      .getByRole('link', { name: 'Share' })
      .click();
    await expect(page).toHaveURL(`/documents/${payroll.id}/share`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Share “${payroll.name}”`);
    const bobRow = page.getByRole('row', { name: 'Bob Baker' });
    await expect(bobRow.getByRole('radio', { name: 'None' })).toBeChecked();
    await expect(page.getByRole('row', { name: 'Alice Adams' })).toHaveCount(0);
    await bobRow.getByRole('radio', { name: 'Viewer' }).check();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL(`/dashboard?shared=${payroll.id}`);
    await expect(page.getByRole('status')).toHaveText(`Shared “${payroll.name}”.`);
    // Her listing, at least as fresh as the row she just shared, is exact at once; a share changes nothing in
    // it, so what this proves is that the hint costs the sharer nothing.
    expect(await dashboardRows(page)).toEqual(alicesRows);

    // Bob's listing may lag the share by up to one window (§7.3); his row reads are exact at once.
    await logIn(bobPage, seed.users.bob.email, seedPassword());
    await dashboardShows(
      bobPage,
      bobsRows('read-only'),
      'the share did not reach the listing inside the lag a listing may have',
    );
    await bobPage.goto(`/documents/${payroll.id}/edit`);
    await expect(bobPage.getByRole('heading', { level: 1 })).toHaveText('Read-only');

    // Alice takes it back: the form shows what the last share left, at the row's token.
    await page.goto(`/documents/${payroll.id}/share`);
    await expect(bobRow.getByRole('radio', { name: 'Viewer' })).toBeChecked();
    await bobRow.getByRole('radio', { name: 'None' }).check();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toHaveText(`Shared “${payroll.name}”.`);

    // At once, before any listing catches up: the row's token postdates the removal, so the read refuses (§7.3).
    const gone = await bobPage.goto(`/documents/${payroll.id}/edit`);
    expect(gone?.status()).toBe(404);
    await expect(bobPage.getByRole('heading', { level: 1 })).toHaveText('Not found');
    await dashboardShows(
      bobPage,
      bobsRows(),
      'the removal did not reach the listing inside the lag a listing may have',
    );
    await logOut(bobPage, seed.users.bob.email);
  } finally {
    // The seed's state whatever happened above: Payroll has no direct share. The same-origin POST of the form,
    // with the session's token as Alice's page carries it.
    await page.request.post(`/documents/${payroll.id}/shares`, {
      form: {
        [`role:${seed.users.bob.id}`]: 'none',
        [`role:${seed.users.carol.id}`]: 'none',
        csrf_token: await csrfToken(page),
      },
      headers: { origin: BASE_URL },
      maxRedirects: 0,
    });
    await bob.close();
  }
  await logOut(page, seed.users.alice.email);
});
