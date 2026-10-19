/**
 * The forbidden POST (docs/README.md §6.5, §9): the "Read-only" marker is a hint, the save route is the control.
 * Carol's browser session posts to `POST /documents/:id` directly, the way a crafted request would, with the
 * session cookie the context holds, the `Origin` a browser form would send, and the session's synchronizer
 * token as a page rendered it: a document she may only view answers 403 and one she may not see answers 404;
 * a cross-origin post to the document she may edit is refused before any lookup, and so is a same-origin post
 * without the token (§9, "CSRF").
 */
import { test, expect } from '@playwright/test';

import { BASE_URL, csrfToken, logIn, readSeed, seedPassword } from './stack';

const seed = readSeed();
const values = { value1: 'crafted', value2: 'crafted' };

test('a POST carol is not allowed to make is refused on the server', async ({ page }) => {
  await logIn(page, seed.users.carol.email, seedPassword());
  const form = { ...values, csrf_token: await csrfToken(page) };

  const budget = await page.request.post(`/documents/${seed.documents.budget.id}`, {
    form,
    headers: { origin: BASE_URL },
    maxRedirects: 0,
  });
  expect(budget.status()).toBe(403);

  const payroll = await page.request.post(`/documents/${seed.documents.payroll.id}`, {
    form,
    headers: { origin: BASE_URL },
    maxRedirects: 0,
  });
  expect(payroll.status()).toBe(404);

  const crossOrigin = await page.request.post(`/documents/${seed.documents['launch-plan'].id}`, {
    form,
    headers: { origin: 'http://evil.example' },
    maxRedirects: 0,
  });
  expect(crossOrigin.status()).toBe(403);

  const noToken = await page.request.post(`/documents/${seed.documents['launch-plan'].id}`, {
    form: values,
    headers: { origin: BASE_URL },
    maxRedirects: 0,
  });
  expect(noToken.status()).toBe(403);
});
