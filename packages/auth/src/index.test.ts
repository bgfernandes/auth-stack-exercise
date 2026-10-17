import { describe, expect, it } from '@jest/globals';

import { packageName } from './index';

describe('@auth-stack/auth', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@auth-stack/auth');
  });
});
