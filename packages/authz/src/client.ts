/**
 * The SpiceDB client of the stack: one factory from the environment and the typed helpers every service uses.
 * Each helper takes the consistency explicitly (docs/README.md §7.3) and the ones that write, or check on a write
 * path, return the ZedToken of the response so the caller can store it with the content.
 */
import { deadlineInterceptor, v1 } from '@authzed/authzed-node';

import { type Consistency, type ZedToken } from './consistency.js';
import {
  type ObjectRef,
  type ObjectType,
  type PermissionOf,
  type RelationshipUpdate,
} from './vocabulary.js';

export interface AuthzOptions {
  /** `host:port` of SpiceDB's gRPC API: `spicedb:50051` in compose, `localhost:50051` from the host. */
  endpoint: string;
  /** The key every client presents as a bearer token (`--grpc-preshared-key`). */
  presharedKey: string;
  /** Plaintext gRPC, for the development stack; off means TLS with the system's certificate authorities. */
  insecure: boolean;
  /** Deadline of every call; a hung authorization service must fail a request rather than hang it. */
  deadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 10_000;

/** Reads `SPICEDB_ENDPOINT`, `SPICEDB_PRESHARED_KEY`, and `SPICEDB_INSECURE` (`true` for plaintext). */
export function authzOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): AuthzOptions {
  const endpoint = env.SPICEDB_ENDPOINT;
  const presharedKey = env.SPICEDB_PRESHARED_KEY;
  if (!endpoint) throw new Error('missing environment variable SPICEDB_ENDPOINT');
  if (!presharedKey) throw new Error('missing environment variable SPICEDB_PRESHARED_KEY');
  return { endpoint, presharedKey, insecure: env.SPICEDB_INSECURE === 'true' };
}

export interface CheckRequest<T extends ObjectType> {
  resource: ObjectRef<T>;
  permission: PermissionOf<T>;
  subject: ObjectRef;
  consistency: Consistency;
}

export interface CheckResult {
  allowed: boolean;
  /** The revision the check was evaluated at; what a write path stores with the content (§7.3). */
  token: ZedToken;
}

export interface CheckItem<T extends ObjectType> {
  resource: ObjectRef<T>;
  permission: PermissionOf<T>;
  subject: ObjectRef;
}

export interface LookupRequest<T extends ObjectType> {
  type: T;
  permission: PermissionOf<T>;
  subject: ObjectRef;
  consistency: Consistency;
}

/** Which relationships `deleteRelationships` removes; every field after the resource type narrows the set. */
export interface RelationshipFilter {
  resourceType: ObjectType;
  resourceId?: string;
  resourceIdPrefix?: string;
  relation?: string;
  subject?: { type: ObjectType; id?: string };
}

export interface Authz {
  /** `CheckPermission` for one resource, permission, and subject. */
  check<T extends ObjectType>(request: CheckRequest<T>): Promise<CheckResult>;
  /** `CheckBulkPermissions`: one result per item, in order, all at the same consistency. */
  bulkCheck<T extends ObjectType>(
    items: CheckItem<T>[],
    consistency: Consistency,
  ): Promise<boolean[]>;
  /** `LookupResources`: the IDs of every resource of the type on which the subject has the permission. */
  lookupResources<T extends ObjectType>(request: LookupRequest<T>): Promise<string[]>;
  /** `WriteRelationships`, atomically; returns the revision written. */
  writeRelationships(updates: RelationshipUpdate[]): Promise<ZedToken>;
  /** `DeleteRelationships` by filter; returns the revision written. */
  deleteRelationships(filter: RelationshipFilter): Promise<ZedToken>;
  /** `ReadSchema`: the schema as SpiceDB serializes it, or undefined when none has been written. */
  readSchema(): Promise<string | undefined>;
  /** `WriteSchema`; returns the revision written. The idempotent wrapper is `ensureSchema` (schema.ts). */
  writeSchema(schema: string): Promise<ZedToken>;
  /** Closes the gRPC channel; a process that does not is kept alive by it. */
  close(): void;
}

export function createAuthz(options: AuthzOptions): Authz {
  // INSECURE_LOCALHOST_ALLOWED would send no bearer to any endpoint not literally `localhost:*` (the library
  // checks the string), so the plaintext mode has to be the explicit one for compose's `spicedb:50051`.
  const security = options.insecure
    ? v1.ClientSecurity.INSECURE_PLAINTEXT_CREDENTIALS
    : v1.ClientSecurity.SECURE;
  const client = v1.NewClient(options.presharedKey, options.endpoint, security, undefined, {
    interceptors: [deadlineInterceptor(options.deadlineMs ?? DEFAULT_DEADLINE_MS)],
  });
  const api = client.promises;

  return {
    async check(request) {
      const response = await api.checkPermission(
        v1.CheckPermissionRequest.create({
          consistency: toConsistency(request.consistency),
          resource: toObject(request.resource),
          permission: request.permission,
          subject: toSubject(request.subject),
        }),
      );
      return { allowed: isAllowed(response.permissionship), token: tokenOf(response.checkedAt) };
    },

    async bulkCheck(items, consistency) {
      if (items.length === 0) return [];
      const response = await api.checkBulkPermissions(
        v1.CheckBulkPermissionsRequest.create({
          consistency: toConsistency(consistency),
          items: items.map((item) =>
            v1.CheckBulkPermissionsRequestItem.create({
              resource: toObject(item.resource),
              permission: item.permission,
              subject: toSubject(item.subject),
            }),
          ),
        }),
      );
      return response.pairs.map((pair) => {
        if (pair.response.oneofKind !== 'item') {
          const detail =
            pair.response.oneofKind === 'error' ? pair.response.error.message : 'no response';
          throw new Error(`CheckBulkPermissions item failed: ${detail}`);
        }
        return isAllowed(pair.response.item.permissionship);
      });
    },

    async lookupResources(request) {
      const responses = await api.lookupResources(
        v1.LookupResourcesRequest.create({
          consistency: toConsistency(request.consistency),
          resourceObjectType: request.type,
          permission: request.permission,
          subject: toSubject(request.subject),
        }),
      );
      return responses
        .filter((item) => item.permissionship === v1.LookupPermissionship.HAS_PERMISSION)
        .map((item) => item.resourceObjectId);
    },

    async writeRelationships(updates) {
      const response = await api.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: updates.map((update) =>
            v1.RelationshipUpdate.create({
              operation: OPERATIONS[update.operation],
              relationship: v1.Relationship.create({
                resource: toObject(update.relationship.resource),
                relation: update.relationship.relation,
                subject: toSubject(update.relationship.subject),
              }),
            }),
          ),
        }),
      );
      return tokenOf(response.writtenAt);
    },

    async deleteRelationships(filter) {
      const response = await api.deleteRelationships(
        v1.DeleteRelationshipsRequest.create({
          relationshipFilter: v1.RelationshipFilter.create({
            resourceType: filter.resourceType,
            optionalResourceId: filter.resourceId ?? '',
            optionalResourceIdPrefix: filter.resourceIdPrefix ?? '',
            optionalRelation: filter.relation ?? '',
            ...(filter.subject && {
              optionalSubjectFilter: v1.SubjectFilter.create({
                subjectType: filter.subject.type,
                optionalSubjectId: filter.subject.id ?? '',
              }),
            }),
          }),
        }),
      );
      return tokenOf(response.deletedAt);
    },

    async readSchema() {
      try {
        const response = await api.readSchema(v1.ReadSchemaRequest.create());
        return response.schemaText;
      } catch (error) {
        if (isGrpcNotFound(error)) return undefined;
        throw error;
      }
    },

    async writeSchema(schema) {
      const response = await api.writeSchema(v1.WriteSchemaRequest.create({ schema }));
      return tokenOf(response.writtenAt);
    },

    close() {
      client.close();
    },
  };
}

const OPERATIONS = {
  create: v1.RelationshipUpdate_Operation.CREATE,
  touch: v1.RelationshipUpdate_Operation.TOUCH,
  delete: v1.RelationshipUpdate_Operation.DELETE,
} as const;

function toObject(ref: ObjectRef): v1.ObjectReference {
  return v1.ObjectReference.create({ objectType: ref.type, objectId: ref.id });
}

function toSubject(ref: ObjectRef): v1.SubjectReference {
  return v1.SubjectReference.create({ object: toObject(ref) });
}

export function toConsistency(consistency: Consistency): v1.Consistency {
  switch (consistency.level) {
    case 'minimize_latency':
      return v1.Consistency.create({
        requirement: { oneofKind: 'minimizeLatency', minimizeLatency: true },
      });
    case 'at_least_as_fresh':
      return v1.Consistency.create({
        requirement: {
          oneofKind: 'atLeastAsFresh',
          atLeastAsFresh: v1.ZedToken.create({ token: consistency.token }),
        },
      });
    case 'fully_consistent':
      return v1.Consistency.create({
        requirement: { oneofKind: 'fullyConsistent', fullyConsistent: true },
      });
  }
}

/** Caveats are not used, so a conditional answer is treated as no permission rather than evaluated further. */
function isAllowed(permissionship: v1.CheckPermissionResponse_Permissionship): boolean {
  return permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;
}

function tokenOf(token: v1.ZedToken | undefined): ZedToken {
  if (!token?.token) throw new Error('SpiceDB response carries no ZedToken');
  return token.token;
}

/** gRPC status NOT_FOUND, as `@grpc/grpc-js` numbers it; compared by value to keep the gRPC package transitive. */
const GRPC_NOT_FOUND = 5;

function isGrpcNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === GRPC_NOT_FOUND
  );
}
