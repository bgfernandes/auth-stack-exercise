import { describe, expect, it, jest } from '@jest/globals';

import { ensureSchema, SCHEMA } from './schema.js';
import { VOCABULARY } from './vocabulary.js';

/** The definitions of a schema text: name → relations (with subject type) and permissions, by a small parser. */
function parseDefinitions(schema: string) {
  const definitions: Record<string, { relations: Record<string, string>; permissions: string[] }> =
    {};
  for (const match of schema.matchAll(/definition (\w+) \{([^}]*)\}/g)) {
    const [, name = '', body = ''] = match;
    const relations: Record<string, string> = {};
    for (const relation of body.matchAll(/^\s*relation (\w+): (\w+)/gm)) {
      relations[relation[1] ?? ''] = relation[2] ?? '';
    }
    const permissions = [...body.matchAll(/^\s*permission (\w+)/gm)].map((m) => m[1] ?? '');
    definitions[name] = { relations, permissions };
  }
  return definitions;
}

describe('schema.zed', () => {
  it('turns typechecking on and annotates every permission', () => {
    expect(SCHEMA).toMatch(/^use typechecking$/m);
    for (const line of SCHEMA.split('\n')) {
      if (/^\s*permission /.test(line))
        expect(line).toMatch(/^\s*permission \w+: \w+( \| \w+)* = /);
    }
  });

  it('matches the TypeScript vocabulary, definition by definition', () => {
    const definitions = parseDefinitions(SCHEMA);
    const expected = Object.fromEntries(
      Object.entries(VOCABULARY).map(([name, { relations, permissions }]) => [
        name,
        { relations, permissions: [...permissions] },
      ]),
    );
    expect(definitions).toEqual(expected);
  });

  it('carries a doc comment on every definition, relation, and permission', () => {
    const lines = SCHEMA.split('\n');
    lines.forEach((line, index) => {
      if (/^\s*(definition|relation|permission) /.test(line)) {
        expect(lines[index - 1]).toMatch(/^\s*\/\*\* .* \*\/$/);
      }
    });
  });
});

describe('ensureSchema', () => {
  function fakeAuthz(reads: (string | undefined)[]) {
    const queue = [...reads];
    return {
      readSchema: jest.fn(() => Promise.resolve(queue.shift())),
      writeSchema: jest.fn((_schema: string) => Promise.resolve('token')),
    };
  }

  it('reports created when SpiceDB had no schema', async () => {
    const authz = fakeAuthz([undefined]);
    await expect(ensureSchema(authz)).resolves.toEqual({ action: 'created' });
    expect(authz.writeSchema).toHaveBeenCalledWith(SCHEMA);
    expect(authz.readSchema).toHaveBeenCalledTimes(1);
  });

  it('reports unchanged when the read-back is the same before and after the write', async () => {
    const authz = fakeAuthz(['definition user {}', 'definition user {}']);
    await expect(ensureSchema(authz)).resolves.toEqual({ action: 'unchanged' });
    expect(authz.writeSchema).toHaveBeenCalledTimes(1);
  });

  it('reports updated when the write changed what SpiceDB serves', async () => {
    const authz = fakeAuthz(['definition user {}', 'definition user {}\ndefinition client {}']);
    await expect(ensureSchema(authz)).resolves.toEqual({ action: 'updated' });
  });
});
