import { describe, expect, it } from '@jest/globals';

import { packageName } from './index.js';

describe('@auth-stack/tenancy', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@auth-stack/tenancy');
  });
});
