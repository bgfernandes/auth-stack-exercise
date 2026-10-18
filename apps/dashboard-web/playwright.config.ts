/**
 * The end-to-end suite (docs/TICKETS.md tickets 13 and 20): the login-and-edit flow of the three seeded users,
 * and the single sign-on and sign-out between the two web apps, driven through a real browser against a running
 * stack. Nothing is started here: the apps must already answer at `E2E_BASE_URL` (default: the compose stack
 * with the apps profile, or Tilt, both at dashboard.localtest.me:3000) and, for the sign-on spec, at
 * `E2E_TENANCY_WEB_URL` (tenancy.localtest.me:3001), and bootstrap must have written `.local/config/seed.json`,
 * which the specs read for the users and document IDs.
 * Chromium only: the flow is server-rendered forms and redirects with no browser-specific code. Run with
 * `pnpm test:e2e` from the workspace root.
 */
import { defineConfig, devices } from '@playwright/test';

import { BASE_URL } from './e2e/stack';

const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  // The spec files are independent (disjoint documents, one browser context and so one IdP session each), so
  // they may run in parallel; the tests inside a file run in order, since each walks one user's flow. One worker
  // on CI, where the stack shares two cores.
  fullyParallel: false,
  ...(CI ? { workers: 1 } : {}),
  // One retry on CI: a run that passed on the retry is reported as flaky, not hidden. None locally.
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  // The list on the terminal; the HTML report (with the trace of every failed test) in playwright-report/, which
  // `pnpm exec playwright show-report apps/dashboard-web/playwright-report` opens and CI uploads on failure.
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // Zitadel's certificate is signed by the stack's development CA (docker/tls), which the browser does not
    // trust; the apps themselves are plain HTTP. Nothing on the Node side of the suite calls Zitadel.
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
