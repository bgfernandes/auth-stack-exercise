/**
 * The response headers of docs/README.md §9 ("Headers"), computed in one place for the web apps' `proxy.ts`
 * (through `@auth-stack/auth/next`) and the APIs' Fastify hook (`@auth-stack/auth/fastify`), so the two apps of
 * each kind cannot drift. The web policy allows no inline script but the ones carrying the nonce minted for the
 * response, which Next.js stamps on its own scripts when it finds the policy on the request; `form-action`
 * names the IdP's origin beside the app's own, because the logout form is answered with a redirect to the
 * end-session endpoint and Chromium applies the directive to that redirect. What depends on TLS follows the
 * app URL's scheme, as `Secure` on the cookie does: HSTS and `upgrade-insecure-requests` would break a
 * plain-HTTP localhost. The APIs serve JSON to no browser: their policy allows nothing at all.
 */
import { randomBytes } from 'node:crypto';

export interface WebSecurityHeaderOptions {
  /** The app's public URL (`APP_URL`): `https` turns on HSTS and `upgrade-insecure-requests`. */
  appUrl: string;
  /** The IdP's issuer (`OIDC_ISSUER`): its origin is a `form-action` the logout's redirect needs. */
  issuer: string;
  /** This response's nonce, fresh per response (`newNonce()`). */
  nonce: string;
  /**
   * `next dev`: `'unsafe-eval'` for scripts and `'unsafe-inline'` for styles, which Next.js's guide says the
   * dev server needs (a nonce beside `'unsafe-inline'` would disable it, so the dev styles carry no nonce).
   */
  development?: boolean;
}

/** 128 random bits, base64: a value no page could guess, new for every response. */
export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** The headers of one response of a web app, the policy carrying the nonce. */
export function webSecurityHeaders(options: WebSecurityHeaderOptions): Record<string, string> {
  const secure = new URL(options.appUrl).protocol === 'https:';
  const nonce = `'nonce-${options.nonce}'`;
  const directives = [
    `default-src 'self'`,
    `script-src 'self' ${nonce} 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' ${options.development ? "'unsafe-inline'" : nonce}`,
    `img-src 'self'`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'self' ${new URL(options.issuer).origin}`,
    `frame-ancestors 'none'`,
    ...(secure ? ['upgrade-insecure-requests'] : []),
  ];
  return {
    'Content-Security-Policy': directives.join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    ...(secure
      ? { 'Strict-Transport-Security': `max-age=${ONE_YEAR_SECONDS}; includeSubDomains` }
      : {}),
  };
}

/** The headers of every response of an API: JSON for no browser, cached nowhere, framed by nobody. */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
});
