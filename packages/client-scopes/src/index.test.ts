import { describe, expect, it } from '@jest/globals';

import {
  minimizeLatency,
  type Authz,
  type LookupRequest,
  type ObjectType,
} from '@auth-stack/authz';

import { apiScope, client, createScopeResolver, scopeFromObjectId, scopeObjectId } from './index';

describe('scope object IDs', () => {
  it('map a scope string to an object ID and back', () => {
    expect(scopeObjectId('documents:write')).toBe('documents_write');
    expect(scopeFromObjectId('documents_write')).toBe('documents:write');
    expect(apiScope('tenancy:read')).toEqual({ type: 'api_scope', id: 'tenancy_read' });
    expect(client('dashboard-web')).toEqual({ type: 'client', id: 'dashboard-web' });
    for (const scope of ['documents:read', 'tenancy:write', 'comments:read']) {
      expect(scopeFromObjectId(scopeObjectId(scope))).toBe(scope);
    }
  });

  it('reject anything that is not <api>:<verb>, and ignore IDs the grammar does not produce', () => {
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
    for (const id of ['documents', 'a_b_c', 'Documents_Write', 'documents:write', '']) {
      expect(scopeFromObjectId(id)).toBeUndefined();
    }
  });
});

describe('createScopeResolver', () => {
  const lookups: LookupRequest<ObjectType>[] = [];
  const grants: Record<string, string[]> = {
    'first-party': ['tenancy_read', 'tenancy_write', 'not_a_scope_id'],
    'third-party': ['tenancy_read'],
  };
  const authz = {
    lookupResources: (request: LookupRequest<ObjectType>) => {
      lookups.push(request);
      return Promise.resolve(grants[request.subject.id] ?? []);
    },
  } as unknown as Authz;
  const claims = (client_id: string) => ({ sub: 'alice', client_id });

  it('resolves a client through one lookup on api_scope#invoke and maps the IDs back', async () => {
    const resolver = createScopeResolver(authz);
    await expect(resolver.resolveScopes(claims('first-party'))).resolves.toEqual(
      new Set(['tenancy:read', 'tenancy:write']),
    );
    await expect(resolver.resolveScopes(claims('third-party'))).resolves.toEqual(
      new Set(['tenancy:read']),
    );
    await expect(resolver.resolveScopes(claims('unknown'))).resolves.toEqual(new Set());
    expect(lookups.at(-1)).toEqual({
      type: 'api_scope',
      permission: 'invoke',
      subject: { type: 'client', id: 'unknown' },
      consistency: minimizeLatency,
    });
  });

  it('caches per client for the TTL, including an empty result, and shares a lookup in flight', async () => {
    const clock = { now: 1_000_000 };
    const resolver = createScopeResolver(authz, { ttlMs: 60_000, now: () => clock.now });
    const before = lookups.length;
    await Promise.all([1, 2, 3].map(() => resolver.resolveScopes(claims('first-party'))));
    await resolver.resolveScopes(claims('unknown'));
    await resolver.resolveScopes(claims('unknown'));
    expect(lookups.length - before).toBe(2);
    clock.now += 60_000;
    await resolver.resolveScopes(claims('first-party'));
    expect(lookups.length - before).toBe(3);
    resolver.invalidate('unknown');
    await resolver.resolveScopes(claims('unknown'));
    expect(lookups.length - before).toBe(4);
    resolver.invalidate();
    await resolver.resolveScopes(claims('first-party'));
    expect(lookups.length - before).toBe(5);
  });
});
