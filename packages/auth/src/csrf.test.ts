import { describe, expect, it } from '@jest/globals';

import { CSRF_FIELD, csrfTokenOf, verifyCsrfToken } from './csrf';

const secret = 'dev-session-secret-needs-at-least-32-chars';
const session = { id: 'ZmFrZS1zZXNzaW9uLWlkLW9mLTMyLWJ5dGVzLWxvbmc' };

describe('the synchronizer token', () => {
  it('is a base64url HMAC of the session ID, the same for one session and different for another', () => {
    const token = csrfTokenOf(session, secret);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain(session.id);
    expect(csrfTokenOf(session, secret)).toBe(token);
    expect(csrfTokenOf({ id: 'another-session' }, secret)).not.toBe(token);
    expect(csrfTokenOf(session, `${secret}-rotated`)).not.toBe(token);
    expect(CSRF_FIELD).toBe('csrf_token');
  });

  it('verifies the session’s token and nothing else, never throwing on what a form may carry', () => {
    const token = csrfTokenOf(session, secret);
    expect(verifyCsrfToken(session, secret, token)).toBe(true);
    expect(verifyCsrfToken({ id: 'another-session' }, secret, token)).toBe(false);
    expect(verifyCsrfToken(session, `${secret}-rotated`, token)).toBe(false);
    for (const bad of [
      undefined,
      null,
      '',
      token.slice(1),
      `${token}=`,
      token.toUpperCase(),
      new File(['x'], 'x.txt'),
      42,
    ]) {
      expect(verifyCsrfToken(session, secret, bad)).toBe(false);
    }
  });
});
