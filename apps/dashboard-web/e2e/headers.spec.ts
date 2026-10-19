/**
 * The security headers (docs/README.md §9): every page of the app answers with the policy and the other
 * headers, the policy is enforced (not report-only), and no page violates it: Next.js's own scripts carry the
 * nonce the proxy minted, and the logout form's redirect to Zitadel passes `form-action`. A listener installed
 * before each document loads records the violations the browser would otherwise only print to its console.
 */
import { test, expect, type Page } from '@playwright/test';

import { logIn, logOut, readSeed, seedPassword } from './stack';

const seed = readSeed();

/**
 * `pnpm test:e2e:tilt`: the apps are `next dev` servers, whose policy carries the two relaxations of §9. Told,
 * not inferred from the policy: a production server that leaked a relaxation must fail here, not pass as a
 * dev server, so each mode asserts the whole policy and a run against the other stack fails on its first page.
 */
const DEV_SERVER = process.env.E2E_DEV_SERVER === '1';

/** The policy of §9 as `packages/auth` builds it for a plain-HTTP app URL, around the nonce of one response. */
function policyWith(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${DEV_SERVER ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' ${DEV_SERVER ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self' https://auth.localtest.me:8443",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The nonce a policy carries; the assertion on the whole policy says what is wrong when there is none. */
function nonceOf(policy: string): string {
  return /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1] ?? '';
}

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__cspViolations ?? []);
}

test('every page carries the headers and none violates the policy', async ({ page }) => {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  const landing = await page.goto('/');
  const headers = landing?.headers() ?? {};
  const policy = headers['content-security-policy'] ?? '';
  expect(nonceOf(policy)).not.toBe('');
  expect(policy).toBe(policyWith(nonceOf(policy)));
  expect(headers).toMatchObject({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
  });
  expect(headers).not.toHaveProperty('content-security-policy-report-only');
  expect(await violations(page)).toEqual([]);
  // The control: the policy is enforced, and the listener records what it blocks. An inline script written into
  // the HTML the server sent, the way an injection would, does not run (Playwright's own `addScriptTag` would,
  // since the browser exempts what the automation protocol evaluates, so the injection is on the wire).
  await page.route('**/*', async (route) => {
    const response = await route.fetch();
    if (!(response.headers()['content-type'] ?? '').includes('text/html'))
      return route.fulfill({ response });
    const body = (await response.text()).replace(
      '</body>',
      '<script>window.__injected = true;</script></body>',
    );
    return route.fulfill({ response, body });
  });
  await page.goto('/');
  expect(await page.evaluate(() => '__injected' in window)).toBe(false);
  expect(await violations(page)).toEqual(['script-src-elem inline']);
  await page.unroute('**/*');

  await logIn(page, seed.users.alice.email, seedPassword());
  const dashboard = await page.goto('/dashboard');
  const dashboardPolicy = dashboard?.headers()['content-security-policy'] ?? '';
  expect(dashboardPolicy).toBe(policyWith(nonceOf(dashboardPolicy)));
  expect(dashboardPolicy).not.toBe(policy);
  expect(await violations(page)).toEqual([]);

  for (const path of [
    `/documents/${seed.documents.payroll.id}/edit`,
    `/documents/${seed.documents.payroll.id}/share`,
    '/documents/00000000-0000-4000-8000-000000000000/edit',
  ]) {
    const response = await page.goto(path);
    expect(response?.headers()['content-security-policy']).toMatch(/'nonce-/);
    expect(await violations(page)).toEqual([]);
  }

  // The logout form's redirect to Zitadel's end-session endpoint, under form-action.
  await logOut(page, seed.users.alice.email);
});
