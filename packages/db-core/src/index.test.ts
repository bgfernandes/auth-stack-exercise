import { describe, expect, it } from '@jest/globals';

import { packageName } from './index.js';

describe('@auth-stack/db-core', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@auth-stack/db-core');
  });
});
