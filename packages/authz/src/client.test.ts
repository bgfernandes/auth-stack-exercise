import { describe, expect, it } from '@jest/globals';

import { authzOptionsFromEnv, type CheckItem } from './client.js';
import { fullyConsistent } from './consistency.js';
import { ref } from './vocabulary.js';

describe('authzOptionsFromEnv', () => {
  it('reads the endpoint, the key, and the plaintext switch', () => {
    expect(
      authzOptionsFromEnv({
        SPICEDB_ENDPOINT: 'spicedb:50051',
        SPICEDB_PRESHARED_KEY: 'dev-preshared-key',
        SPICEDB_INSECURE: 'true',
      }),
    ).toEqual({ endpoint: 'spicedb:50051', presharedKey: 'dev-preshared-key', insecure: true });
  });

  it('defaults to TLS: only the literal `true` turns plaintext on', () => {
    const base = { SPICEDB_ENDPOINT: 'authz.example.com:443', SPICEDB_PRESHARED_KEY: 'k' };
    expect(authzOptionsFromEnv(base).insecure).toBe(false);
    expect(authzOptionsFromEnv({ ...base, SPICEDB_INSECURE: '1' }).insecure).toBe(false);
    expect(authzOptionsFromEnv({ ...base, SPICEDB_INSECURE: 'TRUE' }).insecure).toBe(false);
  });

  it('fails on a missing endpoint or key rather than connecting nowhere', () => {
    expect(() => authzOptionsFromEnv({ SPICEDB_PRESHARED_KEY: 'k' })).toThrow('SPICEDB_ENDPOINT');
    expect(() => authzOptionsFromEnv({ SPICEDB_ENDPOINT: 'spicedb:50051' })).toThrow(
      'SPICEDB_PRESHARED_KEY',
    );
    expect(() =>
      authzOptionsFromEnv({ SPICEDB_ENDPOINT: '', SPICEDB_PRESHARED_KEY: '' }),
    ).toThrow();
  });
});

describe('request types', () => {
  it('tie the permission to the resource type at compile time', () => {
    const items: CheckItem<'document'>[] = [
      { resource: ref('document', 'a'), permission: 'edit', subject: ref('user', 'u') },
      // @ts-expect-error `administer` is a project and organization permission, not a document one
      { resource: ref('document', 'b'), permission: 'administer', subject: ref('user', 'u') },
    ];
    expect(items).toHaveLength(2);
    expect(fullyConsistent.level).toBe('fully_consistent');
  });
});
