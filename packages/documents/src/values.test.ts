import { describe, expect, it } from '@jest/globals';
import { ZodError } from 'zod';

import { parseDocumentValues } from './values.js';

describe('parseDocumentValues', () => {
  it('accepts two strings of 1 to 200 characters', () => {
    expect(parseDocumentValues({ value1: 'a', value2: 'b'.repeat(200) })).toEqual({
      value1: 'a',
      value2: 'b'.repeat(200),
    });
  });

  it.each([
    ['an empty value', { value1: '', value2: 'b' }],
    ['a value over 200 characters', { value1: 'a', value2: 'b'.repeat(201) }],
    ['a missing value', { value1: 'a' }],
    ['an extra field', { value1: 'a', value2: 'b', name: 'renamed' }],
    ['a non-string', { value1: 1, value2: 'b' }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseDocumentValues(input)).toThrow(ZodError);
  });
});
