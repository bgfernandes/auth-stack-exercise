/** The HTTP client over a stub API: the requests it sends, the answers it parses, the errors it raises. */
import { describe, expect, it } from '@jest/globals';

import { createHttpDocumentsClient, DocumentsClientError, isDocumentsClientError } from './http';

const DOCUMENT = '5eed0000-0000-4000-8000-000000000001';
const PROJECT = '5eed0000-0000-4000-8000-000000000002';
const ACME = '5eed0000-0000-4000-8000-000000000003';
const alice = { sub: 'alice', accessToken: 'token-alice' };

const documentWire = {
  id: DOCUMENT,
  project_id: PROJECT,
  organization_id: ACME,
  name: 'Budget',
  value_1: 'Approved spend',
  value_2: '120000',
  updated_at: '2026-10-18T10:00:00.000Z',
  updated_by: 'alice',
};
const document = {
  id: DOCUMENT,
  projectId: PROJECT,
  organizationId: ACME,
  name: 'Budget',
  value1: 'Approved spend',
  value2: '120000',
  updatedAt: new Date('2026-10-18T10:00:00.000Z'),
  updatedBy: 'alice',
};

interface Seen {
  method: string;
  path: string;
  token: string | null;
  contentType: string | null;
  body: string | undefined;
}

/** A stub API: answers by method and path, and records every request it saw. */
function stubApi(
  answer: (method: string, path: string) => { status: number; body?: unknown; raw?: string },
) {
  const seen: Seen[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    seen.push({
      method,
      path: url.pathname,
      token: headers.get('authorization'),
      contentType: headers.get('content-type'),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const { status, body, raw } = answer(method, url.pathname);
    return Promise.resolve(
      new Response(raw ?? (body === undefined ? null : JSON.stringify(body)), {
        status,
        headers: { 'content-type': raw === undefined ? 'application/json' : 'text/html' },
      }),
    );
  };
  return { fetch: fetchStub, seen };
}

describe('createHttpDocumentsClient', () => {
  it('sends the user token on every call, the writes as JSON, and parses the wire format', async () => {
    const api = stubApi((method, path) => {
      if (path === '/documents')
        return {
          status: 200,
          body: {
            documents: [
              {
                id: DOCUMENT,
                name: 'Budget',
                project: { id: PROJECT, name: 'Finance' },
                organization: { id: ACME, name: null },
                can_edit: false,
                can_share: false,
                updated_at: '2026-10-18T10:00:00.000Z',
              },
            ],
          },
        };
      if (method === 'GET' && path === `/documents/${DOCUMENT}/shares`)
        return { status: 200, body: { editors: ['bob'], viewers: [] } };
      if (path === `/organizations/${ACME}/personal-project`)
        return {
          status: 200,
          body: {
            project: {
              id: PROJECT,
              organization_id: ACME,
              name: 'Personal',
              is_personal: true,
              created_at: '2026-10-18T09:00:00.000Z',
            },
            document: documentWire,
            created: true,
          },
        };
      return {
        status: 200,
        body: { ...documentWire, ...(method === 'PUT' ? { value_2: 'x' } : {}) },
      };
    });
    const client = createHttpDocumentsClient({
      baseUrl: 'http://dashboard-api:4002/',
      fetch: api.fetch,
    });

    expect(await client.listVisibleDocuments(alice)).toEqual([
      {
        id: DOCUMENT,
        name: 'Budget',
        project: { id: PROJECT, name: 'Finance' },
        organization: { id: ACME, name: undefined },
        canEdit: false,
        canShare: false,
        updatedAt: new Date('2026-10-18T10:00:00.000Z'),
      },
    ]);
    expect(await client.getDocumentForEdit(alice, DOCUMENT)).toEqual(document);
    expect(await client.getDocumentShares(alice, DOCUMENT)).toEqual({
      editors: ['bob'],
      viewers: [],
    });
    expect(await client.updateDocument(alice, DOCUMENT, { value1: 'a', value2: 'x' })).toEqual({
      ...document,
      value2: 'x',
    });
    expect(
      await client.setDocumentShares(alice, DOCUMENT, { editors: ['bob'], viewers: [] }),
    ).toEqual({ ...document, value2: 'x' });
    expect(await client.ensurePersonalProject(alice, ACME)).toEqual({
      project: {
        id: PROJECT,
        organizationId: ACME,
        name: 'Personal',
        isPersonal: true,
        createdAt: new Date('2026-10-18T09:00:00.000Z'),
      },
      document,
      created: true,
    });

    expect(api.seen).toEqual([
      {
        method: 'GET',
        path: '/documents',
        token: 'Bearer token-alice',
        contentType: null,
        body: undefined,
      },
      {
        method: 'GET',
        path: `/documents/${DOCUMENT}`,
        token: 'Bearer token-alice',
        contentType: null,
        body: undefined,
      },
      {
        method: 'GET',
        path: `/documents/${DOCUMENT}/shares`,
        token: 'Bearer token-alice',
        contentType: null,
        body: undefined,
      },
      {
        method: 'PUT',
        path: `/documents/${DOCUMENT}`,
        token: 'Bearer token-alice',
        contentType: 'application/json',
        body: '{"value_1":"a","value_2":"x"}',
      },
      {
        method: 'PUT',
        path: `/documents/${DOCUMENT}/shares`,
        token: 'Bearer token-alice',
        contentType: 'application/json',
        body: '{"editors":["bob"],"viewers":[]}',
      },
      {
        method: 'POST',
        path: `/organizations/${ACME}/personal-project`,
        token: 'Bearer token-alice',
        contentType: null,
        body: undefined,
      },
    ]);
  });

  it('raises the status and the code of every answer outside the contract', async () => {
    const api = stubApi((method, path) => {
      if (method === 'GET' && path.endsWith('/shares'))
        return { status: 403, body: { error: 'forbidden' } };
      if (path.endsWith('/shares')) return { status: 400, body: { error: 'not_a_member' } };
      if (method === 'PUT') return { status: 403, body: { error: 'forbidden' } };
      if (path === '/documents') return { status: 401, body: { error: 'invalid_token' } };
      if (path.endsWith('/personal-project'))
        return { status: 502, raw: '<html>Bad Gateway</html>' };
      return { status: 404, body: { error: 'not_found' } };
    });
    const client = createHttpDocumentsClient({
      baseUrl: 'http://dashboard-api:4002',
      fetch: api.fetch,
    });

    const refused = await client.listVisibleDocuments(alice).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DocumentsClientError);
    expect(refused).toMatchObject({ status: 401, code: 'invalid_token' });
    expect((refused as Error).message).toBe('GET /documents: 401 invalid_token');
    await expect(client.getDocumentForEdit(alice, DOCUMENT)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    await expect(
      client.updateDocument(alice, DOCUMENT, { value1: 'a', value2: 'b' }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    await expect(
      client.setDocumentShares(alice, DOCUMENT, { editors: ['ghost'], viewers: [] }),
    ).rejects.toMatchObject({ status: 400, code: 'not_a_member' });
    await expect(client.getDocumentShares(alice, DOCUMENT)).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    // A body that is not the API's (a proxy's page) keeps the status and gets a generic code.
    await expect(client.ensurePersonalProject(alice, ACME)).rejects.toMatchObject({
      status: 502,
      code: 'http_error',
    });
    expect(JSON.stringify(api.seen.map((request) => request.body))).not.toContain('token-alice');
  });

  it('refuses an answer that does not match the wire format', async () => {
    const api = stubApi(() => ({
      status: 200,
      body: { ...documentWire, updated_at: 'yesterday' },
    }));
    const client = createHttpDocumentsClient({
      baseUrl: 'http://dashboard-api:4002',
      fetch: api.fetch,
    });
    await expect(client.getDocumentForEdit(alice, DOCUMENT)).rejects.toThrow(/updated_at/);
  });

  it('recognizes its error by shape, as another copy of the module would throw it', () => {
    expect(isDocumentsClientError(new DocumentsClientError(404, 'not_found', 'gone'))).toBe(true);
    expect(
      isDocumentsClientError(
        Object.assign(new Error('gone'), {
          name: 'DocumentsClientError',
          status: 404,
          code: 'not_found',
        }),
      ),
    ).toBe(true);
    expect(isDocumentsClientError(new Error('gone'))).toBe(false);
    expect(isDocumentsClientError({ name: 'DocumentsClientError', status: 404, code: 'x' })).toBe(
      false,
    );
  });
});
