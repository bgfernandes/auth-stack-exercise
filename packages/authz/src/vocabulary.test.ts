import { describe, expect, it } from '@jest/globals';

import { create, ref, relationship, remove, touch } from './vocabulary';

describe('ref', () => {
  it("accepts SpiceDB's object ID grammar and rejects the rest", () => {
    expect(ref('document', 'c2a1f0d6-3b7e-4f8a-9c1d-2e3f4a5b6c7d')).toEqual({
      type: 'document',
      id: 'c2a1f0d6-3b7e-4f8a-9c1d-2e3f4a5b6c7d',
    });
    expect(ref('api_scope', 'documents_write').id).toBe('documents_write');
    expect(() => ref('api_scope', 'documents:write')).toThrow('invalid SpiceDB object ID');
    expect(() => ref('user', '')).toThrow('invalid SpiceDB object ID');
    expect(() => ref('user', 'a b')).toThrow('invalid SpiceDB object ID');
  });
});

describe('relationship', () => {
  it('builds resource#relation@subject and the three update kinds', () => {
    const rel = relationship(
      ref('project', 'marketing'),
      'organization',
      ref('organization', 'acme'),
    );
    expect(rel).toEqual({
      resource: { type: 'project', id: 'marketing' },
      relation: 'organization',
      subject: { type: 'organization', id: 'acme' },
    });
    expect(touch(rel).operation).toBe('touch');
    expect(create(rel).operation).toBe('create');
    expect(remove(rel).operation).toBe('delete');
  });

  it('rejects a relation or a subject type the schema does not have, at compile time', () => {
    // @ts-expect-error `document` has no `owner` relation
    relationship(ref('document', 'd'), 'owner', ref('user', 'u'));
    // @ts-expect-error `organization#admin` admits users, not clients
    relationship(ref('organization', 'acme'), 'admin', ref('client', 'c'));
    // @ts-expect-error the structural relation takes the parent, not a user
    relationship(ref('project', 'p'), 'organization', ref('user', 'u'));
    expect(true).toBe(true);
  });
});
