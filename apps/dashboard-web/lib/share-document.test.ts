import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { DocumentsClientError, type DocumentSummary } from '@auth-stack/documents/client';

import { createDocumentSharer, sharesOf } from './share-document';

const APP_URL = 'http://dashboard.localtest.me:3000';
const DOCUMENT_ID = '0f0a7d1e-8c1a-4f0b-9a0c-5d3e2f1a0b9c';
const alice = { sub: 'alice', accessToken: 'at-secret' };

const setDocumentShares =
  jest.fn<(user: unknown, id: string, shares: unknown) => Promise<DocumentSummary>>();
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
const share = createDocumentSharer({
  documents: { setDocumentShares },
  appUrl: APP_URL,
  userFromRequest,
  logger,
});

function post(
  options: { origin?: string; body?: BodyInit; headers?: Record<string, string> } = {},
) {
  const body =
    options.body ?? new URLSearchParams({ 'role:bob': 'viewer', 'role:carol': 'editor' });
  return new Request(`${APP_URL}/documents/${DOCUMENT_ID}/shares`, {
    method: 'POST',
    headers: { ...(options.origin ? { origin: options.origin } : {}), ...options.headers },
    body,
  });
}

beforeEach(() => {
  setDocumentShares.mockReset();
  userFromRequest.mockReset().mockResolvedValue(alice);
  events.length = 0;
});

describe('the share route', () => {
  it('refuses a cross-site request before reading the session', async () => {
    const response = await share(post({ origin: 'http://evil.example' }), DOCUMENT_ID);
    expect(response.status).toBe(403);
    expect(userFromRequest).not.toHaveBeenCalled();
    expect(setDocumentShares).not.toHaveBeenCalled();
    expect(events.map((e) => [e.level, e.event])).toEqual([['warn', 'document.share_rejected']]);
  });

  it('answers 401 without a session', async () => {
    userFromRequest.mockResolvedValue(undefined);
    const response = await share(post({ origin: APP_URL }), DOCUMENT_ID);
    expect(response.status).toBe(401);
    expect(setDocumentShares).not.toHaveBeenCalled();
  });

  it('answers 400 to a body that is not the form, without calling the API', async () => {
    for (const body of [
      new URLSearchParams({ 'role:bob': 'owner' }),
      new URLSearchParams([
        ['role:bob', 'viewer'],
        ['role:bob', 'editor'],
      ]),
      new URLSearchParams({ 'role:': 'viewer' }),
      JSON.stringify({ editors: ['bob'] }),
    ]) {
      const response = await share(post({ origin: APP_URL, body }), DOCUMENT_ID);
      expect(response.status).toBe(400);
    }
    expect(setDocumentShares).not.toHaveBeenCalled();
  });

  it('replaces the shares with the set the form describes, as the user, and goes back to the dashboard', async () => {
    setDocumentShares.mockResolvedValue({ id: DOCUMENT_ID } as DocumentSummary);
    const response = await share(
      post({
        origin: APP_URL,
        body: new URLSearchParams({
          'role:bob': 'viewer',
          'role:carol': 'editor',
          'role:dave': 'none',
          other: 'ignored',
        }),
      }),
      DOCUMENT_ID,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${APP_URL}/dashboard?shared=${DOCUMENT_ID}`);
    expect(setDocumentShares).toHaveBeenCalledWith(alice, DOCUMENT_ID, {
      editors: ['carol'],
      viewers: ['bob'],
    });
    expect(events).toEqual([
      {
        level: 'info',
        event: 'document.shared',
        fields: { sub: 'alice', documentId: DOCUMENT_ID, editors: 1, viewers: 1 },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('at-secret');
  });

  it('answers the status of a refusal: 403 for a user who may not share, 404 for one who may not see', async () => {
    setDocumentShares.mockRejectedValueOnce(new DocumentsClientError(403, 'forbidden', 'no'));
    const forbidden = await share(post({ origin: APP_URL }), DOCUMENT_ID);
    expect(forbidden.status).toBe(403);
    setDocumentShares.mockRejectedValueOnce(new DocumentsClientError(404, 'not_found', 'no'));
    const missing = await share(post({ origin: APP_URL }), DOCUMENT_ID);
    expect(missing.status).toBe(404);
    expect(events.map((e) => [e.event, e.fields?.code])).toEqual([
      ['document.share_denied', 'forbidden'],
      ['document.share_denied', 'not_found'],
    ]);
  });

  it('sends a member the API refuses back to the form, and lets anything else surface', async () => {
    setDocumentShares.mockRejectedValueOnce(new DocumentsClientError(400, 'not_a_member', 'no'));
    const refused = await share(post({ origin: APP_URL }), DOCUMENT_ID);
    expect(refused.status).toBe(303);
    expect(refused.headers.get('location')).toBe(
      `${APP_URL}/documents/${DOCUMENT_ID}/share?error=member`,
    );
    setDocumentShares.mockRejectedValueOnce(new DocumentsClientError(400, 'invalid_input', 'no'));
    await expect(share(post({ origin: APP_URL }), DOCUMENT_ID)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    setDocumentShares.mockRejectedValueOnce(new Error('api down'));
    await expect(share(post({ origin: APP_URL }), DOCUMENT_ID)).rejects.toThrow('api down');
  });
});

describe('sharesOf', () => {
  it('reads one role per member and keeps the order of the form', () => {
    const form = new FormData();
    form.set('role:a', 'none');
    form.set('role:b', 'editor');
    form.set('role:c', 'viewer');
    form.set('role:d', 'editor');
    expect(sharesOf(form)).toEqual({ editors: ['b', 'd'], viewers: ['c'] });
    expect(sharesOf(new FormData())).toEqual({ editors: [], viewers: [] });
  });
});
