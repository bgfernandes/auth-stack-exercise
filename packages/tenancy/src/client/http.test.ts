import { describe, expect, it } from '@jest/globals';

import { createHttpTenancyClient, TenancyClientError } from './http';

const organization = {
  id: '0b5a2b18-1b4e-4e59-9a8d-0d4b3c3f1a11',
  name: 'Acme',
  is_personal: false,
  policy: {},
};
const summary = { id: organization.id, name: 'Acme', isPersonal: false, policy: {} };
const alice = { sub: 'alice', accessToken: 'token-alice' };
const bob = { sub: 'bob', accessToken: 'token-bob' };

/** A stub API: answers by path and token, and counts the requests it saw. */
function stubApi(answers: Record<string, (token: string) => { status: number; body?: unknown }>) {
  const requests: string[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const headers = new Headers(init?.headers);
    const token = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    requests.push(`${init?.method ?? 'GET'} ${url.pathname} ${token}`);
    const answer = answers[url.pathname]?.(token) ?? { status: 404, body: { error: 'not_found' } };
    return Promise.resolve(
      new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch: fetchStub, requests };
}

describe('createHttpTenancyClient', () => {
  it('sends the user token, parses the wire format, and maps 404 to undefined', async () => {
    const api = stubApi({
      [`/organizations/${organization.id}`]: (token) =>
        token === 'token-alice'
          ? { status: 200, body: organization }
          : { status: 404, body: { error: 'not_found' } },
      '/me/organizations': () => ({ status: 200, body: { organizations: [organization] } }),
      '/me/provision': () => ({ status: 200, body: { organization, created: true } }),
    });
    const client = createHttpTenancyClient({
      baseUrl: 'http://tenancy-api:4001/',
      fetch: api.fetch,
    });
    expect(await client.getOrganization(alice, organization.id)).toEqual(summary);
    expect(await client.getOrganization(bob, organization.id)).toBeUndefined();
    expect(await client.listOrganizations(alice)).toEqual([summary]);
    expect(await client.provisionUser(alice)).toEqual({ organization: summary, created: true });
    expect(api.requests).toEqual([
      `GET /organizations/${organization.id} token-alice`,
      `GET /organizations/${organization.id} token-bob`,
      'GET /me/organizations token-alice',
      'POST /me/provision token-alice',
    ]);
  });

  it('caches hits and misses per user and organization for the TTL, deduplicating concurrent asks', async () => {
    let clock = 1_000_000;
    const api = stubApi({
      [`/organizations/${organization.id}`]: (token) =>
        token === 'token-alice'
          ? { status: 200, body: organization }
          : { status: 404, body: { error: 'not_found' } },
    });
    const client = createHttpTenancyClient({
      baseUrl: 'http://tenancy-api:4001',
      fetch: api.fetch,
      cacheTtlMs: 60_000,
      now: () => clock,
    });
    const [first, second] = await Promise.all([
      client.getOrganization(alice, organization.id),
      client.getOrganization(alice, organization.id),
    ]);
    expect(first).toEqual(summary);
    expect(second).toEqual(summary);
    expect(await client.getOrganization(bob, organization.id)).toBeUndefined();
    expect(await client.getOrganization(bob, organization.id)).toBeUndefined();
    expect(api.requests).toHaveLength(2); // one per user; the miss is cached too
    client.invalidate('alice');
    await client.getOrganization(alice, organization.id);
    await client.getOrganization(bob, organization.id);
    expect(api.requests).toHaveLength(3); // bob's answer survived alice's invalidation
    clock += 59_000;
    await client.getOrganization(alice, organization.id);
    expect(api.requests).toHaveLength(3);
    clock += 2_000;
    await client.getOrganization(alice, organization.id);
    expect(api.requests).toHaveLength(4);
  });

  it('throws TenancyClientError with the status and the API code on any other answer', async () => {
    const api = stubApi({
      '/me/organizations': () => ({ status: 401, body: { error: 'invalid_token' } }),
      '/me/provision': () => ({ status: 502, body: { error: 'userinfo_unavailable' } }),
      [`/organizations/${organization.id}`]: () => ({ status: 500, body: 'Internal Server Error' }),
    });
    const client = createHttpTenancyClient({
      baseUrl: 'http://tenancy-api:4001',
      fetch: api.fetch,
    });
    await expect(client.listOrganizations(alice)).rejects.toMatchObject({
      name: 'TenancyClientError',
      status: 401,
      code: 'invalid_token',
    });
    await expect(client.provisionUser(alice)).rejects.toMatchObject({
      status: 502,
      code: 'userinfo_unavailable',
    });
    const error = await client.getOrganization(alice, organization.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenancyClientError);
    expect(error).toMatchObject({ status: 500, code: 'http_error' });
  });

  it('reports a non-JSON error page through its status', async () => {
    const html: typeof fetch = () =>
      Promise.resolve(
        new Response('<h1>502 Bad Gateway</h1>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      );
    const client = createHttpTenancyClient({ baseUrl: 'http://tenancy-api:4001', fetch: html });
    await expect(client.listOrganizations(alice)).rejects.toMatchObject({
      status: 502,
      code: 'http_error',
    });
  });

  it('rejects a body that is not the wire format', async () => {
    const api = stubApi({
      '/me/organizations': () => ({
        status: 200,
        body: { organizations: [{ ...organization, extra: 1 }] },
      }),
    });
    const client = createHttpTenancyClient({
      baseUrl: 'http://tenancy-api:4001',
      fetch: api.fetch,
    });
    await expect(client.listOrganizations(alice)).rejects.toThrow(/unrecognized key/i);
  });
});
