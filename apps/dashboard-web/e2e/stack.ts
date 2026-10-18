/**
 * What the specs share: where the stack is, who the seeded users are (docs/README.md §6.3, from the seed.json
 * bootstrap wrote), and the steps every flow repeats: logging in through Zitadel's login page, reading the
 * dashboard table, editing a document and putting it back, logging out.
 */
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { expect, type Page } from '@playwright/test';

/** The repository root: this file is apps/dashboard-web/e2e/stack.ts. */
const ROOT = new URL('../../../', import.meta.url);
const SEED_FILE = new URL('.local/config/seed.json', ROOT);

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://dashboard.localtest.me:3000';

export type UserKey = 'alice' | 'bob' | 'carol';
export type DocumentLabel = 'launch-plan' | 'budget' | 'payroll';

/** `.local/config/seed.json`, as apps/bootstrap/src/handoff.ts writes it. */
export interface Seed {
  users: Record<UserKey, { id: string; email: string }>;
  organization: { id: string; name: string };
  projects: Record<string, { id: string; name: string }>;
  documents: Record<DocumentLabel, { id: string; name: string; project: string }>;
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
 * waits for the dashboard, where the callback lands a successful login.
 */
export async function logIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/auth/login');
  await page.getByLabel('Loginname').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL('/dashboard');
}

/**
 * Logs out with the header's form and proves both sessions ended: the landing page offers "Log in" again, and a
 * direct request for the dashboard goes through the app's login route to Zitadel's login-name form rather than
 * to a silent sign-in, so the IdP session is gone too (docs/README.md §4.4 step 5).
 */
export async function logOut(page: Page): Promise<void> {
  const header = page.getByRole('navigation');
  await header.getByRole('button', { name: 'Log out' }).click();
  await expect(header.getByRole('link', { name: 'Log in' })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Log out' })).toHaveCount(0);
  await page.goto('/dashboard');
  await expect(page.getByLabel('Loginname')).toBeVisible();
}

export interface DashboardRow {
  organization: string;
  project: string;
  document: string;
  access: 'edit' | 'read-only';
}

export function row(
  organization: string,
  project: string,
  document: string,
  access: DashboardRow['access'],
): DashboardRow {
  return { organization, project, document, access };
}

/** The dashboard as rows in page order: the page groups by organization (h2) and project (h3), one table each. */
export async function dashboardRows(page: Page): Promise<DashboardRow[]> {
  const rows: DashboardRow[] = [];
  for (const organization of await page.locator('main > section').all()) {
    const organizationName = after('Organization: ', await organization.locator('h2').innerText());
    for (const project of await organization.locator('section').all()) {
      const projectName = after('Project: ', await project.locator('h3').innerText());
      for (const tr of await project.locator('tbody tr').all()) {
        const document = await tr.locator('td').first().innerText();
        const editable = (await tr.getByRole('link', { name: 'Edit' }).count()) > 0;
        rows.push(row(organizationName, projectName, document, editable ? 'edit' : 'read-only'));
      }
    }
  }
  return rows;
}

function after(prefix: string, text: string): string {
  if (!text.startsWith(prefix)) throw new Error(`expected "${prefix}…", got "${text}"`);
  return text.slice(prefix.length);
}

/**
 * The edit flow from the dashboard: "Edit" on the document's row, a new second value saved, the dashboard's
 * confirmation, the value read back from the edit page, then the original values saved again so the seeded
 * scenario is as documented after the run (bootstrap never resets a value).
 */
export async function editAndRestore(
  page: Page,
  document: { id: string; name: string },
  marker: string,
): Promise<void> {
  await page.getByRole('row', { name: document.name }).getByRole('link', { name: 'Edit' }).click();
  await expect(page).toHaveURL(`/documents/${document.id}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(document.name);
  const value1 = page.getByLabel('Value 1');
  const value2 = page.getByLabel('Value 2');
  const original = { value1: await value1.inputValue(), value2: await value2.inputValue() };

  await value2.fill(marker);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(`/dashboard?saved=${document.id}`);
  await expect(page.getByRole('status')).toHaveText(`Saved “${document.name}”.`);

  await page.goto(`/documents/${document.id}/edit`);
  await expect(value1).toHaveValue(original.value1);
  await expect(value2).toHaveValue(marker);

  await value2.fill(original.value2);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText(`Saved “${document.name}”.`);
  await page.goto(`/documents/${document.id}/edit`);
  await expect(value2).toHaveValue(original.value2);
  await page.goto('/dashboard');
}

/** A value no seed carries, so a leftover from a failed run is recognizable. */
export function marker(user: UserKey): string {
  return `e2e ${user} ${new Date().toISOString()}`;
}
