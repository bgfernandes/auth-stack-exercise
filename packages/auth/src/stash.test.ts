import { describe, expect, it } from '@jest/globals';

import { AuthError } from './errors';
import { openStash, sealStash, type LoginStash } from './stash';

const SECRET = 'a-development-secret-of-at-least-32-chars';
const NOW = 1_700_000_000_000;
const stash: LoginStash = { state: 's', nonce: 'n', codeVerifier: 'v', expiresAt: NOW + 600_000 };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AuthError ? error.code : undefined;
  }
  return undefined;
}

describe('login stash', () => {
  it('round-trips through a sealed cookie value', () => {
    expect(openStash(sealStash(stash, SECRET), SECRET, NOW)).toEqual(stash);
  });

  it('refuses a missing, malformed, or forged value as no login in progress', () => {
    const sealed = sealStash(stash, SECRET);
    expect(codeOf(() => openStash(undefined, SECRET, NOW))).toBe('no_login_in_progress');
    expect(codeOf(() => openStash('garbage', SECRET, NOW))).toBe('no_login_in_progress');
    expect(codeOf(() => openStash(sealed, 'another-secret-of-at-least-32-characters', NOW))).toBe(
      'no_login_in_progress',
    );
    const [payload, signature] = sealed.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...stash, state: 'x' })).toString('base64url');
    expect(codeOf(() => openStash(`${forged}.${signature}`, SECRET, NOW))).toBe(
      'no_login_in_progress',
    );
    expect(codeOf(() => openStash(`${payload}.${signature.slice(1)}`, SECRET, NOW))).toBe(
      'no_login_in_progress',
    );
  });

  it('refuses a stash past its expiry', () => {
    expect(codeOf(() => openStash(sealStash(stash, SECRET), SECRET, stash.expiresAt))).toBe(
      'login_expired',
    );
  });

  it('does not put the secret or a readable token in the value', () => {
    expect(sealStash(stash, SECRET)).not.toContain(SECRET);
    expect(sealStash(stash, SECRET)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});
