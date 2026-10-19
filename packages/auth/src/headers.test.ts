import { describe, expect, it } from '@jest/globals';

import { API_SECURITY_HEADERS, newNonce, webSecurityHeaders } from './headers';

const issuer = 'https://auth.localtest.me:8443';

describe('the web apps’ security headers', () => {
  it('allow scripts and styles with the response’s nonce only, and the IdP as a form action', () => {
    const nonce = newNonce();
    const headers = webSecurityHeaders({
      appUrl: 'http://dashboard.localtest.me:3000',
      issuer,
      nonce,
    });
    expect(headers['Content-Security-Policy']).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
        `style-src 'self' 'nonce-${nonce}'`,
        "img-src 'self'",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self' https://auth.localtest.me:8443",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    expect(headers).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
    });
    expect(headers).not.toHaveProperty('Strict-Transport-Security');
    expect(headers['Content-Security-Policy']).not.toContain('upgrade-insecure-requests');
    expect(headers['Content-Security-Policy']).not.toContain('unsafe');
  });

  it('turn on HSTS and the upgrade over https only, as Secure on the cookie', () => {
    const headers = webSecurityHeaders({ appUrl: 'https://dashboard.example', issuer, nonce: 'n' });
    expect(headers['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
    expect(headers['Content-Security-Policy']).toMatch(/; upgrade-insecure-requests$/);
  });

  it('give the dev server eval and inline styles, the styles then without a nonce', () => {
    const headers = webSecurityHeaders({
      appUrl: 'http://dashboard.localtest.me:3000',
      issuer,
      nonce: 'n',
      development: true,
    });
    expect(headers['Content-Security-Policy']).toContain(
      "script-src 'self' 'nonce-n' 'strict-dynamic' 'unsafe-eval'; style-src 'self' 'unsafe-inline';",
    );
  });

  it('mint a nonce no page could guess, new every time', () => {
    const nonces = new Set(Array.from({ length: 20 }, () => newNonce()));
    expect(nonces.size).toBe(20);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe('the APIs’ security headers', () => {
  it('allow nothing and cache nothing', () => {
    expect(API_SECURITY_HEADERS).toEqual({
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
    });
    expect(Object.isFrozen(API_SECURITY_HEADERS)).toBe(true);
  });
});
