import { describe, expect, it } from '@jest/globals';
import { ZodError } from 'zod';

import { parsePolicy } from './policy.js';

describe('parsePolicy', () => {
  it('accepts the empty policy and every known floor', () => {
    expect(parsePolicy({})).toEqual({});
    expect(
      parsePolicy({ require_mfa: true, max_auth_age_seconds: 600, require_idp: 'idp-1' }),
    ).toEqual({
      require_mfa: true,
      max_auth_age_seconds: 600,
      require_idp: 'idp-1',
    });
  });

  it.each([
    ['an unknown field', { require_sso: true }],
    ['a non-positive age', { max_auth_age_seconds: 0 }],
    ['a fractional age', { max_auth_age_seconds: 1.5 }],
    ['an empty IdP', { require_idp: '' }],
    ['a non-object', 'strict'],
  ])('rejects %s', (_label, input) => {
    expect(() => parsePolicy(input)).toThrow(ZodError);
  });
});
