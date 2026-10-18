import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { DocumentsError, type Document } from '@auth-stack/documents';

import { createDocumentSaver } from './save-document';

const APP_URL = 'http://dashboard.localtest.me:3000';
const DOCUMENT_ID = '0f0a7d1e-8c1a-4f0b-9a0c-5d3e2f1a0b9c';
const alice = { sub: 'alice', accessToken: 'at-secret' };

const updateDocument = jest.fn<(user: unknown, id: string, values: unknown) => Promise<Document>>();
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
const save = createDocumentSaver({
  documents: { updateDocument },
  appUrl: APP_URL,
  userFromRequest,
  logger,
});

function post(
  options: { origin?: string; body?: BodyInit; headers?: Record<string, string> } = {},
) {
  const body = options.body ?? new URLSearchParams({ value1: 'Goodbye', value2: 'Moon' });
  return new Request(`${APP_URL}/documents/${DOCUMENT_ID}`, {
    method: 'POST',
    headers: { ...(options.origin ? { origin: options.origin } : {}), ...options.headers },
    body,
  });
}

beforeEach(() => {
  updateDocument.mockReset();
  userFromRequest.mockReset().mockResolvedValue(alice);
  events.length = 0;
});

describe('the save route', () => {
  it('refuses a cross-site request before reading the session', async () => {
    const response = await save(post({ origin: 'http://evil.example' }), DOCUMENT_ID);
    expect(response.status).toBe(403);
    expect(userFromRequest).not.toHaveBeenCalled();
    expect(updateDocument).not.toHaveBeenCalled();
    expect(events.map((e) => [e.level, e.event])).toEqual([['warn', 'document.save_rejected']]);
  });

  it('answers 401 without a session', async () => {
    userFromRequest.mockResolvedValue(undefined);
    const response = await save(post({ origin: APP_URL }), DOCUMENT_ID);
    expect(response.status).toBe(401);
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it('sends invalid values back to the form without looking the document up', async () => {
    const response = await save(
      post({ origin: APP_URL, body: new URLSearchParams({ value1: '', value2: 'x'.repeat(201) }) }),
      DOCUMENT_ID,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `${APP_URL}/documents/${DOCUMENT_ID}/edit?error=values`,
    );
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it('answers 400 to a body that is not a form', async () => {
    const response = await save(
      post({
        origin: APP_URL,
        body: '{"value1":"a"}',
        headers: { 'content-type': 'application/json' },
      }),
      DOCUMENT_ID,
    );
    expect(response.status).toBe(400);
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it('saves as the user and sends the browser back to the dashboard with the flash', async () => {
    updateDocument.mockResolvedValue({ id: DOCUMENT_ID } as Document);
    const response = await save(post({ origin: APP_URL }), DOCUMENT_ID);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${APP_URL}/dashboard?saved=${DOCUMENT_ID}`);
    expect(updateDocument).toHaveBeenCalledWith(alice, DOCUMENT_ID, {
      value1: 'Goodbye',
      value2: 'Moon',
    });
    expect(events).toEqual([
      {
        level: 'info',
        event: 'document.updated',
        fields: { sub: 'alice', documentId: DOCUMENT_ID },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('at-secret');
  });

  it('answers 403 when the user may only view the document, 404 when they may not see it', async () => {
    updateDocument.mockRejectedValueOnce(new DocumentsError('forbidden', 'document#edit required'));
    expect((await save(post({ origin: APP_URL }), DOCUMENT_ID)).status).toBe(403);
    updateDocument.mockRejectedValueOnce(new DocumentsError('not_found', 'document not found'));
    expect((await save(post({ origin: APP_URL }), DOCUMENT_ID)).status).toBe(404);
    expect(events.map((e) => e.fields?.code)).toEqual(['forbidden', 'not_found']);
  });

  it('maps the error when another copy of the documents package threw it', async () => {
    updateDocument.mockRejectedValueOnce(
      Object.assign(new Error('document#edit required'), {
        name: 'DocumentsError',
        code: 'forbidden',
      }),
    );
    expect((await save(post({ origin: APP_URL }), DOCUMENT_ID)).status).toBe(403);
  });

  it('lets any other failure surface', async () => {
    updateDocument.mockRejectedValue(new Error('connection refused'));
    await expect(save(post({ origin: APP_URL }), DOCUMENT_ID)).rejects.toThrow(
      'connection refused',
    );
  });
});
