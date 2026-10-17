/**
 * `@auth-stack/authz`: the one place SpiceDB details live (docs/README.md §3.1). The schema file and its write
 * are on the subpath `@auth-stack/authz/schema`, imported by bootstrap only.
 */
export {
  authzOptionsFromEnv,
  createAuthz,
  type Authz,
  type AuthzOptions,
  type CheckItem,
  type CheckRequest,
  type CheckResult,
  type LookupRequest,
  type RelationshipFilter,
} from './client';
export {
  atLeastAsFresh,
  fullyConsistent,
  minimizeLatency,
  type Consistency,
  type ZedToken,
} from './consistency';
export {
  create,
  isObjectId,
  ref,
  relationship,
  remove,
  touch,
  VOCABULARY,
  type ObjectRef,
  type ObjectType,
  type PermissionOf,
  type RelationOf,
  type Relationship,
  type RelationshipOperation,
  type RelationshipUpdate,
  type SubjectTypeOf,
} from './vocabulary';
