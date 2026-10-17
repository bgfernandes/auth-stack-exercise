import { describe, expect, it } from '@jest/globals';

import { redact } from './redact';

describe('redact', () => {
  it('replaces credential-bearing fields at any depth and keeps the rest', () => {
    expect(
      redact({
        event: 'login',
        sub: 'user-1',
        accessToken: 'at',
        refresh_token: 'rt',
        idToken: 'idt',
        sessionId: 'sid',
        nested: { Authorization: 'Bearer x', cookie: 'a=b', list: [{ password: 'p', ok: 1 }] },
      }),
    ).toEqual({
      event: 'login',
      sub: 'user-1',
      accessToken: '[redacted]',
      refresh_token: '[redacted]',
      idToken: '[redacted]',
      sessionId: '[redacted]',
      nested: {
        Authorization: '[redacted]',
        cookie: '[redacted]',
        list: [{ password: '[redacted]', ok: 1 }],
      },
    });
  });

  it('leaves primitives alone', () => {
    expect(redact('token')).toBe('token');
    expect(redact(3)).toBe(3);
    expect(redact(null)).toBeNull();
  });
});
