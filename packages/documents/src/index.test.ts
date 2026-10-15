import { describe, expect, it } from '@jest/globals';

import { packageName as tenancyClientPackage } from '@auth-stack/tenancy/client';

import { packageName } from './index.js';

describe('@auth-stack/documents', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@auth-stack/documents');
  });

  it('resolves the tenancy client through the workspace link', () => {
    expect(tenancyClientPackage).toBe('@auth-stack/tenancy/client');
  });
});
