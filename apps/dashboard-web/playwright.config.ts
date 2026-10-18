/**
 * The end-to-end suite (docs/TICKETS.md ticket 13): the login-and-edit flow of the three seeded users, driven
 * through a real browser against a running stack. Nothing is started here: the apps must already answer at
 * `E2E_BASE_URL` (default: the compose stack with the apps profile, or Tilt, both at dashboard.localtest.me:3000),
 * and bootstrap must have written `.local/config/seed.json`, which the specs read for the users and document IDs.
 * Chromium only: the flow is server-rendered forms and redirects with no browser-specific code. Run with
 * `pnpm test:e2e` from the workspace root.
 */
import { defineConfig, devices } from '@playwright/test';

import { BASE_URL } from './e2e/stack';

const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  // The spec files are independent and edit disjoint documents, so they may run in parallel; the tests inside a
  // file run in order, since each walks one user's flow. One worker on CI, where the stack shares two cores.
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
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
