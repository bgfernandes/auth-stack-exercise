/**
 * The end-to-end suite of tenancy-web (docs/TICKETS.md ticket 17): the member and policy management of the
 * three seeded users, driven through a real browser against a running stack. Nothing is started here: the apps
 * must already answer at `E2E_TENANCY_WEB_URL` (default: the compose stack with the apps profile, or Tilt, both
 * at tenancy.localtest.me:3001), and bootstrap must have written `.local/config/seed.json`, which the specs read
 * for the users and the organization ID. Same shape as apps/dashboard-web/playwright.config.ts; run with
 * `pnpm test:e2e` from the workspace root, which runs both suites.
 */
import { defineConfig, devices } from '@playwright/test';

import { BASE_URL } from './e2e/stack';

const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  // The spec files touch one organization: run them in order, not in parallel, so a change one makes and
  // reverts is never seen by another.
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  forbidOnly: CI,
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
