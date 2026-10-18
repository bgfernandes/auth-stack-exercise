import { describe, expect, it } from '@jest/globals';
import { ZodError } from 'zod';

import { parseDocumentShares } from './shares';

describe('parseDocumentShares', () => {
  it('accepts two lists of user ids, empty ones included', () => {
    expect(parseDocumentShares({ editors: ['123'], viewers: ['456', 'it-bob'] })).toEqual({
      editors: ['123'],
      viewers: ['456', 'it-bob'],
    });
    expect(parseDocumentShares({ editors: [], viewers: [] })).toEqual({ editors: [], viewers: [] });
  });

  it.each([
    ['a user in both lists', { editors: ['1'], viewers: ['1'] }],
    ['a user listed twice', { editors: ['1', '1'], viewers: [] }],
    ['an id SpiceDB cannot name', { editors: ['a:b'], viewers: [] }],
    ['an empty id', { editors: [''], viewers: [] }],
    ['a missing list', { editors: [] }],
    ['an extra field', { editors: [], viewers: [], owners: [] }],
    ['a non-string', { editors: [1], viewers: [] }],
    [
      'more than a hundred',
      { editors: Array.from({ length: 101 }, (_, i) => `${i}`), viewers: [] },
    ],
  ])('rejects %s', (_label, input) => {
    expect(() => parseDocumentShares(input)).toThrow(ZodError);
  });
});
