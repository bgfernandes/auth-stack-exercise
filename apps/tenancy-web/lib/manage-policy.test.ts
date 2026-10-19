import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { TenancyClientError, type TenancyClient } from '@auth-stack/tenancy/client';

import { createPolicyHandler, policyFromForm } from './manage-policy';

const APP_URL = 'http://tenancy.localtest.me:3001';
const ACME = '5eed0000-0000-4000-8000-000000000001';
const alice = { sub: 'alice', accessToken: 'at-secret' };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe('policyFromForm', () => {
  it('builds a policy from the fields that carry a value', () => {
    expect(policyFromForm(form({}))).toEqual({});
    expect(policyFromForm(form({ max_auth_age_seconds: '', require_idp: '  ' }))).toEqual({});
    expect(
      policyFromForm(
        form({ require_mfa: 'on', max_auth_age_seconds: ' 600 ', require_idp: 'idp-1' }),
      ),
    ).toEqual({ require_mfa: true, max_auth_age_seconds: 600, require_idp: 'idp-1' });
  });

  it('refuses what the schema refuses', () => {
    expect(policyFromForm(form({ max_auth_age_seconds: 'soon' }))).toBeUndefined();
    expect(policyFromForm(form({ max_auth_age_seconds: '0' }))).toBeUndefined();
    expect(policyFromForm(form({ max_auth_age_seconds: '1.5' }))).toBeUndefined();
  });
});

describe('the policy route', () => {
  const setPolicy = jest.fn<TenancyClient['setPolicy']>();
  const userFromRequest = jest.fn<(request: Request) => Promise<typeof alice | undefined>>();
  /** The session's token, as the page rendered it; the fake verifies the value and nothing else. */
  const TOKEN = 'the-sessions-token';
  const verifyCsrfToken = jest.fn<(presented: unknown) => Promise<boolean>>();
  const events: string[] = [];
  const handle = createPolicyHandler({
    tenancy: { setPolicy },
    appUrl: APP_URL,
    userFromRequest,
    verifyCsrfToken,
    logger: {
      info: (event) => {
        events.push(event);
      },
      warn: (event) => {
        events.push(event);
      },
    },
  });
  /** A post of the form's fields with the session's token, unless `token` says otherwise (null: none). */
  const post = (fields: Record<string, string>, origin = APP_URL, token: string | null = TOKEN) =>
    new Request(`${APP_URL}/organizations/${ACME}/policy`, {
      method: 'POST',
      headers: { origin },
      body: new URLSearchParams(token === null ? fields : { ...fields, csrf_token: token }),
    });

  beforeEach(() => {
    setPolicy
      .mockReset()
      .mockResolvedValue({ id: ACME, name: 'Acme', isPersonal: false, policy: {} });
    userFromRequest.mockReset().mockResolvedValue(alice);
    verifyCsrfToken
      .mockReset()
      .mockImplementation((presented) => Promise.resolve(presented === TOKEN));
    events.length = 0;
  });

  it('refuses a cross-site request, and a session-less one', async () => {
    expect((await handle(post({}, 'http://evil.example'), ACME)).status).toBe(403);
    userFromRequest.mockResolvedValue(undefined);
    expect((await handle(post({}), ACME)).status).toBe(401);
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('refuses a form without the session’s token, before any call', async () => {
    expect((await handle(post({ require_mfa: 'on' }, APP_URL, null), ACME)).status).toBe(403);
    expect((await handle(post({ require_mfa: 'on' }, APP_URL, 'other'), ACME)).status).toBe(403);
    expect(setPolicy).not.toHaveBeenCalled();
    expect(events).toEqual(['policy.rejected', 'policy.rejected']);
  });

  it('saves the policy the form carries and goes back to the page', async () => {
    const response = await handle(post({ require_mfa: 'on', max_auth_age_seconds: '600' }), ACME);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${APP_URL}/organizations/${ACME}?saved=policy`);
    expect(setPolicy).toHaveBeenCalledWith(alice, ACME, {
      require_mfa: true,
      max_auth_age_seconds: 600,
    });
    expect(events).toEqual(['policy.updated']);
  });

  it('sends an invalid value back to the form without calling the API', async () => {
    const response = await handle(post({ max_auth_age_seconds: 'soon' }), ACME);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `${APP_URL}/organizations/${ACME}?error=invalid_input`,
    );
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('answers 403 to a member and 404 to a stranger, as the API did', async () => {
    setPolicy.mockRejectedValueOnce(new TenancyClientError(403, 'forbidden', 'x'));
    expect((await handle(post({}), ACME)).status).toBe(403);
    setPolicy.mockRejectedValueOnce(new TenancyClientError(404, 'not_found', 'x'));
    expect((await handle(post({}), ACME)).status).toBe(404);
    expect(events).toEqual(['policy.denied', 'policy.denied']);
  });
});
