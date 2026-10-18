import { describe, expect, it } from '@jest/globals';

import { DocumentsError, isDocumentsError } from './errors';

describe('isDocumentsError', () => {
  it('recognizes an instance, and one thrown by another copy of the package', () => {
    expect(isDocumentsError(new DocumentsError('forbidden', 'document#edit required'))).toBe(true);
    const fromAnotherCopy = Object.assign(new Error('document not found'), {
      name: 'DocumentsError',
      code: 'not_found',
    });
    expect(isDocumentsError(fromAnotherCopy)).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isDocumentsError(new Error('document not found'))).toBe(false);
    expect(isDocumentsError(Object.assign(new Error('x'), { name: 'DocumentsError' }))).toBe(false);
    expect(
      isDocumentsError(Object.assign(new Error('x'), { name: 'DocumentsError', code: 'other' })),
    ).toBe(false);
    expect(isDocumentsError({ name: 'DocumentsError', code: 'not_found' })).toBe(false);
    expect(isDocumentsError(undefined)).toBe(false);
  });
});
