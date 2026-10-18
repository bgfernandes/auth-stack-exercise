import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { TenancyClientError, type TenancyClient } from '@auth-stack/tenancy/client';

import { createMembershipHandler } from './manage-members';

const APP_URL = 'http://tenancy.localtest.me:3001';
const ACME = '5eed0000-0000-4000-8000-000000000001';
const alice = { sub: 'alice', accessToken: 'at-secret' };

const setMembership = jest.fn<TenancyClient['setMembership']>();
const userFromRequest = jest.fn<(request: Request) => Promise<typeof alice | undefined>>();
const events: { level: string; event: string; fields: Record<string, unknown> | undefined }[] = [];
const logger = {
  info: (event: string, fields?: Record<string, unknown>) => {
    events.push({ level: 'info', event, fields });
  },
  warn: (event: string, fields?: Record<string, unknown>) => {
    events.push({ level: 'warn', event, fields });
  },
};
const handle = createMembershipHandler({
  tenancy: { setMembership },
  appUrl: APP_URL,
  userFromRequest,
  logger,
});

function post(
  options: { origin?: string; body?: BodyInit; headers?: Record<string, string> } = {},
) {
  const body = options.body ?? new URLSearchParams({ member_id: 'bob', role: 'admin' });
  return new Request(`${APP_URL}/organizations/${ACME}/members`, {
    method: 'POST',
    headers: { ...(options.origin ? { origin: options.origin } : {}), ...options.headers },
    body,
  });
}

beforeEach(() => {
  setMembership.mockReset().mockResolvedValue(undefined);
  userFromRequest.mockReset().mockResolvedValue(alice);
  events.length = 0;
});

describe('the members route', () => {
  it('refuses a cross-site request before reading the session', async () => {
    const response = await handle(post({ origin: 'http://evil.example' }), ACME);
    expect(response.status).toBe(403);
    expect(userFromRequest).not.toHaveBeenCalled();
    expect(setMembership).not.toHaveBeenCalled();
    expect(events.map((e) => [e.level, e.event])).toEqual([['warn', 'membership.rejected']]);
  });

  it('answers 401 without a session and 400 to a body that is not the form', async () => {
    userFromRequest.mockResolvedValue(undefined);
    expect((await handle(post({ origin: APP_URL }), ACME)).status).toBe(401);
    userFromRequest.mockResolvedValue(alice);
    const notAForm = post({
      origin: APP_URL,
      body: '{"member_id":"bob"}',
      headers: { 'content-type': 'application/json' },
    });
    expect((await handle(notAForm, ACME)).status).toBe(400);
    const wrongRole = post({
      origin: APP_URL,
      body: new URLSearchParams({ member_id: 'bob', role: 'owner' }),
    });
    expect((await handle(wrongRole, ACME)).status).toBe(400);
    expect(setMembership).not.toHaveBeenCalled();
  });

  it('sends the change with the user token and goes back to the page', async () => {
    const promoted = await handle(post({ origin: APP_URL }), ACME);
    expect(promoted.status).toBe(303);
    expect(promoted.headers.get('location')).toBe(`${APP_URL}/organizations/${ACME}?saved=members`);
    expect(setMembership).toHaveBeenCalledWith(alice, ACME, 'bob', 'admin');

    const removed = await handle(
      post({ origin: APP_URL, body: new URLSearchParams({ member_id: 'bob', role: 'remove' }) }),
      ACME,
    );
    expect(removed.status).toBe(303);
    expect(setMembership).toHaveBeenLastCalledWith(alice, ACME, 'bob', null);
    expect(events.map((e) => e.event)).toEqual(['membership.changed', 'membership.changed']);
    expect(events[0]?.fields).toEqual({
      sub: 'alice',
      organizationId: ACME,
      memberId: 'bob',
      role: 'admin',
    });
  });

  it('turns the API refusals into statuses or messages, and rethrows an outage', async () => {
    const outcomes: [TenancyClientError, number, string | null][] = [
      [new TenancyClientError(403, 'forbidden', 'x'), 403, null],
      [new TenancyClientError(404, 'not_found', 'x'), 404, null],
      [new TenancyClientError(401, 'invalid_token', 'x'), 401, null],
      [new TenancyClientError(400, 'not_a_member', 'x'), 303, 'not_a_member'],
      [new TenancyClientError(409, 'last_admin', 'x'), 303, 'last_admin'],
      [new TenancyClientError(409, 'personal_organization', 'x'), 303, 'personal_organization'],
    ];
    for (const [error, status, code] of outcomes) {
      setMembership.mockRejectedValueOnce(error);
      const response = await handle(post({ origin: APP_URL }), ACME);
      expect(response.status).toBe(status);
      if (code)
        expect(response.headers.get('location')).toBe(
          `${APP_URL}/organizations/${ACME}?error=${code}`,
        );
    }
    expect(events.filter((e) => e.event === 'membership.denied')).toHaveLength(outcomes.length);
    // No token in any log line.
    expect(JSON.stringify(events)).not.toContain('at-secret');

    // The refusal as another copy of the client module would throw it (a bundler layer): same shape, no shared class.
    const foreign = Object.assign(new Error('x'), {
      name: 'TenancyClientError',
      status: 403,
      code: 'forbidden',
    });
    setMembership.mockRejectedValueOnce(foreign);
    expect((await handle(post({ origin: APP_URL }), ACME)).status).toBe(403);

    setMembership.mockRejectedValueOnce(new TenancyClientError(502, 'http_error', 'x'));
    await expect(handle(post({ origin: APP_URL }), ACME)).rejects.toMatchObject({ status: 502 });
    setMembership.mockRejectedValueOnce(new Error('connection refused'));
    await expect(handle(post({ origin: APP_URL }), ACME)).rejects.toThrow('connection refused');
  });
});
