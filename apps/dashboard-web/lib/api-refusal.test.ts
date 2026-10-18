import { describe, expect, it } from '@jest/globals';

import { DocumentsClientError } from '@auth-stack/documents/client';

import { refusalOf } from './api-refusal';

const refused = (status: number, code: string) =>
  new DocumentsClientError(status, code, `${status} ${code}`);

describe('refusalOf', () => {
  it('maps the three answers the pages have a state for', () => {
    expect(refusalOf(refused(401, 'invalid_token'))).toBe('unauthenticated');
    expect(refusalOf(refused(401, 'missing_token'))).toBe('unauthenticated');
    expect(refusalOf(refused(403, 'forbidden'))).toBe('forbidden');
    expect(refusalOf(refused(404, 'not_found'))).toBe('not_found');
  });

  it('leaves every other answer to surface as a failure', () => {
    // A scope the client was never granted is configuration, not the user's permission.
    expect(refusalOf(refused(403, 'insufficient_scope'))).toBeUndefined();
    // The form was validated with the service's own rule; a disagreement is a bug.
    expect(refusalOf(refused(400, 'invalid_input'))).toBeUndefined();
    expect(refusalOf(refused(502, 'http_error'))).toBeUndefined();
    expect(refusalOf(new Error('connection refused'))).toBeUndefined();
    expect(refusalOf(undefined)).toBeUndefined();
  });
});
