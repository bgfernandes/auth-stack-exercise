/**
 * Cookie attributes and the same-origin check of the BFFs (docs/README.md §9: "Session cookie", "CSRF").
 * The attributes are computed once from the app's public URL; `Secure` follows its scheme, so plain-HTTP
 * localhost works and anything behind TLS is secure without a switch.
 */
import { AuthError } from './errors';

export interface CookieAttributes {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  /** Seconds; absent for a session cookie that the browser drops when it closes. */
  maxAge?: number;
}

export interface CookieAttributeOptions {
  /** The app's public URL (`APP_URL`): its scheme decides `Secure`. */
  appUrl: string;
  /** Defaults to `/`. The login stash narrows it to the callback path. */
  path?: string;
  maxAge?: number;
}

/** `HttpOnly`, `SameSite=Lax`, `Secure` when the app is served over https, `Path=/` unless narrowed, no `Domain`. */
export function cookieAttributes(options: CookieAttributeOptions): CookieAttributes {
  const attributes: CookieAttributes = {
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(options.appUrl).protocol === 'https:',
    path: options.path ?? '/',
  };
  if (options.maxAge !== undefined) attributes.maxAge = options.maxAge;
  return attributes;
}

/** A `Set-Cookie` header value, for hosts without a cookie API (`Max-Age=0` with an empty value clears it). */
export function serializeCookie(name: string, value: string, attributes: CookieAttributes): string {
  const parts = [`${name}=${value}`, `Path=${attributes.path}`, 'HttpOnly', 'SameSite=Lax'];
  if (attributes.secure) parts.push('Secure');
  if (attributes.maxAge !== undefined) parts.push(`Max-Age=${attributes.maxAge}`);
  return parts.join('; ');
}

/** The named cookie of a `Cookie` header, undefined when absent. */
export function readCookie(
  cookieHeader: string | null | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Rejects a state-changing request that did not come from the app's own origin: `Origin` must equal the app's
 * origin, and when the browser sent none, `Sec-Fetch-Site` must say `same-origin`. A request with neither
 * header is rejected; every current browser sends at least one on a cross-site `POST`. Next.js applies the
 * equivalent check to Server Actions only; route handlers call this (docs/README.md §9, "CSRF").
 */
export function assertSameOrigin(request: Request, appUrl: string): void {
  const expected = new URL(appUrl).origin;
  const origin = request.headers.get('origin');
  if (origin !== null) {
    if (origin === expected) return;
    throw new AuthError('forbidden_origin', `request origin is not ${expected}`);
  }
  if (request.headers.get('sec-fetch-site') === 'same-origin') return;
  throw new AuthError(
    'forbidden_origin',
    'request carries neither Origin nor a same-origin Sec-Fetch-Site',
  );
}
