/**
 * The object types, relations, and permissions of schema.zed (docs/README.md §6.2) as one constant, from which
 * the types below derive, so that a misspelled relation or permission, or a subject of the wrong type, fails at
 * compile time rather than with a SpiceDB error at runtime. A unit test keeps it equal to the schema file.
 */
export const VOCABULARY = {
  user: { relations: {}, permissions: [] },
  organization: {
    relations: { admin: 'user', member: 'user' },
    permissions: ['administer', 'view', 'create_project'],
  },
  project: {
    relations: { organization: 'organization', owner: 'user', editor: 'user', viewer: 'user' },
    permissions: ['administer', 'edit', 'view', 'share'],
  },
  document: {
    relations: { project: 'project', editor: 'user', viewer: 'user' },
    permissions: ['edit', 'view', 'share'],
  },
  client: { relations: {}, permissions: [] },
  api_scope: { relations: { grantee: 'client' }, permissions: ['invoke'] },
} as const satisfies Record<
  string,
  { relations: Record<string, string>; permissions: readonly string[] }
>;

export type Vocabulary = typeof VOCABULARY;
export type ObjectType = keyof Vocabulary;
export type RelationOf<T extends ObjectType> = keyof Vocabulary[T]['relations'] & string;
export type PermissionOf<T extends ObjectType> = Vocabulary[T]['permissions'][number];
/** The object type a relation admits as subject (every role relation admits `user`; the structural ones their parent). */
export type SubjectTypeOf<T extends ObjectType, R extends RelationOf<T>> = Extract<
  Vocabulary[T]['relations'][R],
  ObjectType
>;

/** A reference to one object: `document:<id>`. */
export interface ObjectRef<T extends ObjectType = ObjectType> {
  readonly type: T;
  readonly id: string;
}

/** SpiceDB's grammar for object IDs; a colon is not allowed, which is why scope strings are mapped (scopes.ts). */
const OBJECT_ID = /^[a-zA-Z0-9/_|\-=+]{1,1024}$/;

export function isObjectId(id: string): boolean {
  return OBJECT_ID.test(id);
}

export function ref<T extends ObjectType>(type: T, id: string): ObjectRef<T> {
  if (!isObjectId(id))
    throw new Error(`invalid SpiceDB object ID for ${type}: ${JSON.stringify(id)}`);
  return { type, id };
}

/** One relationship, `resource#relation@subject`, already checked against the vocabulary by `relationship()`. */
export interface Relationship {
  readonly resource: ObjectRef;
  readonly relation: string;
  readonly subject: ObjectRef;
}

export function relationship<T extends ObjectType, R extends RelationOf<T>>(
  resource: ObjectRef<T>,
  relation: R,
  subject: ObjectRef<SubjectTypeOf<T, R>>,
): Relationship {
  return { resource, relation, subject };
}

export type RelationshipOperation = 'create' | 'touch' | 'delete';

export interface RelationshipUpdate {
  readonly operation: RelationshipOperation;
  readonly relationship: Relationship;
}

/** Write the relationship whether or not it exists (idempotent; the operation the seeds and provisioning use). */
export function touch(rel: Relationship): RelationshipUpdate {
  return { operation: 'touch', relationship: rel };
}

/** Write the relationship, failing if it already exists. */
export function create(rel: Relationship): RelationshipUpdate {
  return { operation: 'create', relationship: rel };
}

/** Remove the relationship if it exists. */
export function remove(rel: Relationship): RelationshipUpdate {
  return { operation: 'delete', relationship: rel };
}
