/**
 * What the specs share: where the app is, who the seeded users are (docs/README.md §6.3, from the seed.json
 * bootstrap wrote), and the steps every flow repeats: logging in through Zitadel's login page, reading the
 * member table, logging out. The seed and password readers mirror apps/dashboard-web/e2e/stack.ts; the two
 * suites share no code on purpose. The one spec that opens both apps, single sign-on and sign-out (ticket 20),
 * is in the dashboard-web suite, since its assertions are on that app.
 */
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { expect, type Page } from '@playwright/test';

/** The repository root: this file is apps/tenancy-web/e2e/stack.ts. */
const ROOT = new URL('../../../', import.meta.url);
const SEED_FILE = new URL('.local/config/seed.json', ROOT);

export const BASE_URL = process.env.E2E_TENANCY_WEB_URL ?? 'http://tenancy.localtest.me:3001';

export type UserKey = 'alice' | 'bob' | 'carol';

/** The part of `.local/config/seed.json` this suite reads, as apps/bootstrap/src/handoff.ts writes it. */
export interface Seed {
  users: Record<UserKey, { id: string; email: string }>;
  organization: { id: string; name: string };
}

export function readSeed(): Seed {
  let text: string;
  try {
    text = readFileSync(SEED_FILE, 'utf8');
  } catch {
    throw new Error(
      `${SEED_FILE.pathname} is missing: bootstrap writes it when the stack starts (README, Development). ` +
        'Start the stack with the apps (docker compose --profile apps up -d --wait --build, or tilt up) first.',
    );
  }
  return JSON.parse(text) as Seed;
}

/** The seeded users' password: the environment, else the committed development default in the root .env. */
export function seedPassword(): string {
  const password =
    process.env.SEED_USER_PASSWORD ??
    parseEnv(readFileSync(new URL('.env', ROOT), 'utf8')).SEED_USER_PASSWORD;
  if (!password)
    throw new Error('SEED_USER_PASSWORD is set neither in the environment nor in .env');
  return password;
}

/**
 * Logs in from the app's login route through Zitadel's Login V2 pages (the login name, then the password) and
 * waits for the organizations list, where the callback lands a successful login.
 */
export async function logIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/auth/login');
  await page.getByLabel('Loginname').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL('/organizations');
}

/**
 * Logs out with the header's form and proves both sessions ended: the list is behind the login again, and
 * Zitadel asks for the password rather than signing the user in silently. Its login UI lists the browser's
 * sessions as accounts to pick, the ended one included; choosing it leads to the password form (as in
 * apps/dashboard-web/e2e/stack.ts).
 */
export async function logOut(page: Page, email: string): Promise<void> {
  const header = page.getByRole('navigation');
  await header.getByRole('button', { name: 'Log out' }).click();
  await expect(header.getByRole('link', { name: 'Log in' })).toBeVisible();
  await page.goto('/organizations');
  await page.getByRole('button', { name: email }).click();
  await expect(page.getByLabel('Password')).toBeVisible();
}

/**
 * The session's synchronizer token (docs/README.md §9, "CSRF"), read from the header's logout form, which every
 * page of a signed-in user carries: what a crafted post must send to reach the authorization decision.
 */
export async function csrfToken(page: Page): Promise<string> {
  return page.locator('form[action="/auth/logout"] input[name="csrf_token"]').inputValue();
}

export interface MemberRow {
  name: string;
  email: string;
  role: 'Administrator' | 'Member';
}

/** The member table as rows in page order: admins first, then by name (docs/README.md §6.8). */
export async function memberRows(page: Page): Promise<MemberRow[]> {
  const rows: MemberRow[] = [];
  for (const tr of await page.locator('section[aria-labelledby="members"] tbody tr').all()) {
    const cells = await tr.locator('td').allInnerTexts();
    rows.push({
      name: cells[0] ?? '',
      email: cells[1] ?? '',
      role: cells[2] === 'Administrator' ? 'Administrator' : 'Member',
    });
  }
  return rows;
}

/** The seeded Acme member list (§6.3), with the names bootstrap seeds into the users mirror. */
export const ACME_MEMBERS: MemberRow[] = [
  { name: 'Alice Adams', email: 'alice@example.com', role: 'Administrator' },
  { name: 'Bob Baker', email: 'bob@example.com', role: 'Member' },
  { name: 'Carol Clark', email: 'carol@example.com', role: 'Member' },
];
