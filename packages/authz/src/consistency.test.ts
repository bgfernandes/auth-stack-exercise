import { describe, expect, it } from '@jest/globals';

import { toConsistency } from './client';
import { atLeastAsFresh, fullyConsistent, minimizeLatency } from './consistency';

describe('consistency', () => {
  it('maps each level to the matching SpiceDB requirement', () => {
    expect(toConsistency(minimizeLatency).requirement).toEqual({
      oneofKind: 'minimizeLatency',
      minimizeLatency: true,
    });
    expect(toConsistency(fullyConsistent).requirement).toEqual({
      oneofKind: 'fullyConsistent',
      fullyConsistent: true,
    });
    expect(toConsistency(atLeastAsFresh('GhUKEzE3MDAwMDAwMDAwMDAwMDAwMDA=')).requirement).toEqual({
      oneofKind: 'atLeastAsFresh',
      atLeastAsFresh: { token: 'GhUKEzE3MDAwMDAwMDAwMDAwMDAwMDA=' },
    });
  });

  it('refuses an empty token, which would silently mean minimize_latency', () => {
    expect(() => atLeastAsFresh('')).toThrow('needs a ZedToken');
  });
});
