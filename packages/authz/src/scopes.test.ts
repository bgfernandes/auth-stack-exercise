import { describe, expect, it } from '@jest/globals';

import { apiScope, scopeObjectId } from './scopes.js';

describe('scopeObjectId', () => {
  it('maps a scope string to an object ID by replacing the colon', () => {
    expect(scopeObjectId('documents:write')).toBe('documents_write');
    expect(apiScope('tenancy:read')).toEqual({ type: 'api_scope', id: 'tenancy_read' });
  });

  it('rejects anything that is not <api>:<verb>', () => {
    for (const scope of [
      'documents',
      'documents:',
      ':write',
      'Documents:Write',
      'a:b:c',
      'documents_write',
    ]) {
      expect(() => scopeObjectId(scope)).toThrow('invalid API scope');
    }
  });
});
