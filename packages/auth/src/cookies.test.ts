import { describe, expect, it } from '@jest/globals';

import { assertSameOrigin, cookieAttributes, readCookie, serializeCookie } from './cookies';
import { AuthError } from './errors';

describe('cookieAttributes', () => {
  it('is HttpOnly, Lax, Path=/, and Secure only over https', () => {
    expect(cookieAttributes({ appUrl: 'http://dashboard.localtest.me:3000' })).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
    });
    expect(
      cookieAttributes({ appUrl: 'https://app.example.com', path: '/auth/callback', maxAge: 600 }),
    ).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/auth/callback',
      maxAge: 600,
    });
  });

  it('serializes to a Set-Cookie value with no Domain attribute', () => {
    const value = serializeCookie(
      'app_session',
      'abc',
      cookieAttributes({ appUrl: 'https://app.example.com', maxAge: 60 }),
    );
    expect(value).toBe('app_session=abc; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=60');
    expect(value).not.toContain('Domain');
  });
});

describe('readCookie', () => {
  it('finds the named cookie among others', () => {
    expect(readCookie('a=1; app_session=xyz; b=2', 'app_session')).toBe('xyz');
    expect(readCookie('app_session_login=q; app_session=xyz', 'app_session')).toBe('xyz');
    expect(readCookie('a=1', 'app_session')).toBeUndefined();
    expect(readCookie(null, 'app_session')).toBeUndefined();
  });
});

describe('assertSameOrigin', () => {
  const app = 'http://dashboard.localtest.me:3000';
  const request = (headers: Record<string, string>) =>
    new Request(`${app}/auth/logout`, { method: 'POST', headers });

  it('accepts the app origin, and a same-origin fetch without Origin', () => {
    expect(() => assertSameOrigin(request({ origin: app }), app)).not.toThrow();
    expect(() => assertSameOrigin(request({ 'sec-fetch-site': 'same-origin' }), app)).not.toThrow();
  });

  it('rejects another origin, a cross-site fetch, and a request with neither header', () => {
    for (const headers of [
      { origin: 'http://evil.localtest.me:3000' },
      { origin: 'http://dashboard.localtest.me:4000' },
      { origin: 'null' },
      { origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'none' },
      {},
    ]) {
      expect(() => assertSameOrigin(request(headers), app)).toThrow(AuthError);
      expect(() => assertSameOrigin(request(headers), app)).toThrow(
        expect.objectContaining({ code: 'forbidden_origin' }),
      );
    }
  });
});
