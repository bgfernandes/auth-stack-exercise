/**
 * The schema file and the idempotent write bootstrap runs at every start. A subpath export
 * (`@auth-stack/authz/schema`) rather than part of the package root: the `.zed` import needs a text loader,
 * which bootstrap's esbuild build and Jest have and the web apps, which only check permissions, do not.
 */
// The ambient `*.zed` module lives in zed.d.ts; a path reference is the one way to carry it to a consumer
// outside this package's tsconfig (bootstrap's type-check), since a wildcard module cannot be imported.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./zed.d.ts" />
import schemaText from '../schema.zed';

import { type Authz } from './client';

export const SCHEMA: string = schemaText;

export type SchemaAction = 'created' | 'updated' | 'unchanged';

/**
 * Writes schema.zed and reports what changed. SpiceDB serializes the schema its own way on ReadSchema (the
 * `use typechecking` directive and the permission annotations are dropped, definitions reordered), so the file
 * cannot be compared with the read-back; the read-back before and after the write can.
 */
export async function ensureSchema(
  authz: Pick<Authz, 'readSchema' | 'writeSchema'>,
): Promise<{ action: SchemaAction }> {
  const before = await authz.readSchema();
  await authz.writeSchema(SCHEMA);
  if (before === undefined) return { action: 'created' };
  const after = await authz.readSchema();
  return { action: after === before ? 'unchanged' : 'updated' };
}
