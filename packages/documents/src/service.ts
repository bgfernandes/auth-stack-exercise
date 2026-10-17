/**
 * The documents domain service (docs/README.md §5.2, §6.4, §6.5, §7.3): the personal workspace, the dashboard
 * listing, and the edit flow. In-process in `dashboard-web` during phase 1, behind `dashboard-api` from phase 2.
 * Every method checks SpiceDB before touching data, at the consistency level §7.3 assigns to the operation, and
 * every content write stores the token of its check in the same statement as the content.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';

import {
  atLeastAsFresh,
  fullyConsistent,
  ref,
  relationship,
  touch,
  type Authz,
  type Consistency,
} from '@auth-stack/authz';
import { type Db } from '@auth-stack/db-core';
import { type TenancyClient, type UserContext } from '@auth-stack/tenancy/client';

import { DocumentsError } from './errors.js';
import {
  documents,
  projects,
  type Document,
  type DocumentsSchema,
  type Project,
} from './schema.js';
import { parseDocumentValues } from './values.js';

export type DocumentsDb = Db<DocumentsSchema>;

export interface PersonalWorkspace {
  project: Project;
  document: Document;
  /** Whether this call created them; false on every call after the first. */
  created: boolean;
}

/** One dashboard row (§6.5): the document, where it sits, and whether the "Edit" hint applies. */
export interface VisibleDocument {
  id: string;
  name: string;
  project: { id: string; name: string };
  /** The name is undefined when tenancy does not show the organization to the user. */
  organization: { id: string; name: string | undefined };
  canEdit: boolean;
  updatedAt: Date;
}

export interface DocumentsService {
  /**
   * Idempotent (§6.4): creates the "Personal" project and its "Welcome" document in the organization, writes
   * their relationships, and stores the write's token on the document; returns the existing pair afterwards.
   * The user needs `organization#create_project`, checked at full consistency.
   */
  ensurePersonalProject(user: UserContext, organizationId: string): Promise<PersonalWorkspace>;
  /** Every document the user may view, with `canEdit` from one bulk check, both at `consistency` (§6.5). */
  listVisibleDocuments(user: UserContext, consistency: Consistency): Promise<VisibleDocument[]>;
  /** The row for the edit form: `edit` at least as fresh as the row's token; `view` only is forbidden. */
  getDocumentForEdit(user: UserContext, id: string): Promise<Document>;
  /** Validates the values, checks `edit` at full consistency, stores values and the check's token together. */
  updateDocument(user: UserContext, id: string, values: unknown): Promise<Document>;
}

export const PERSONAL_PROJECT_NAME = 'Personal';
export const WELCOME_DOCUMENT = { name: 'Welcome', value1: 'Hello', value2: 'World' } as const;

export function createDocumentsService(deps: {
  db: DocumentsDb;
  authz: Authz;
  tenancy: TenancyClient;
}): DocumentsService {
  const { db, authz, tenancy } = deps;

  async function check(
    user: UserContext,
    documentId: string,
    permission: 'view' | 'edit',
    consistency: Consistency,
  ) {
    return authz.check({
      resource: ref('document', documentId),
      permission,
      subject: ref('user', user.sub),
      consistency,
    });
  }

  async function load(id: string): Promise<Document | undefined> {
    const rows = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    return rows[0];
  }

  /** `403` when the user may view the document, `404` otherwise (§6.5), decided at the consistency of the failed check. */
  async function denied(
    user: UserContext,
    row: Document,
    consistency: Consistency,
  ): Promise<DocumentsError> {
    const view = await check(user, row.id, 'view', consistency);
    return view.allowed
      ? new DocumentsError('forbidden', 'document#edit required')
      : new DocumentsError('not_found', 'document not found');
  }

  /**
   * Runs on the caller's transaction: a loser of the insert race still holds its pooled connection, so looking
   * the winner up through the pool would wait for a second connection every loser is also waiting for.
   */
  async function personal(
    tx: Pick<DocumentsDb, 'select'>,
    organizationId: string,
  ): Promise<PersonalWorkspace | undefined> {
    const [project] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), eq(projects.isPersonal, true)))
      .limit(1);
    if (!project) return undefined;
    const [document] = await tx
      .select()
      .from(documents)
      .where(eq(documents.projectId, project.id))
      .limit(1);
    if (!document) throw new Error('personal project without its document');
    return { project, document, created: false };
  }

  return {
    async ensurePersonalProject(user, organizationId) {
      const permitted = await authz.check({
        resource: ref('organization', organizationId),
        permission: 'create_project',
        subject: ref('user', user.sub),
        consistency: fullyConsistent,
      });
      if (!permitted.allowed) throw new DocumentsError('not_found', 'organization not found');

      return db.transaction(async (tx) => {
        const projectId = randomUUID();
        const documentId = randomUUID();
        const [project] = await tx
          .insert(projects)
          .values({ id: projectId, organizationId, name: PERSONAL_PROJECT_NAME, isPersonal: true })
          // `where` names the partial index's predicate, as Postgres requires for ON CONFLICT on one.
          .onConflictDoNothing({
            target: projects.organizationId,
            where: eq(projects.isPersonal, true),
          })
          .returning();
        if (!project) {
          // Lost the race, or a later call: the index made the winner visible once it committed.
          const existing = await personal(tx, organizationId);
          if (!existing) throw new Error('personal project missing after conflict');
          return existing;
        }
        // Inside the transaction: if SpiceDB refuses, the rows roll back and the next call starts over.
        const token = await authz.writeRelationships([
          touch(
            relationship(
              ref('project', projectId),
              'organization',
              ref('organization', organizationId),
            ),
          ),
          touch(relationship(ref('document', documentId), 'project', ref('project', projectId))),
        ]);
        const [document] = await tx
          .insert(documents)
          .values({
            id: documentId,
            projectId,
            organizationId,
            ...WELCOME_DOCUMENT,
            zedtoken: token,
            updatedBy: user.sub,
          })
          .returning();
        if (!document) throw new Error('document insert returned no row');
        return { project, document, created: true };
      });
    },

    async listVisibleDocuments(user, consistency) {
      const subject = ref('user', user.sub);
      const ids = (
        await authz.lookupResources({ type: 'document', permission: 'view', subject, consistency })
      ).filter(isUuid);
      if (ids.length === 0) return [];
      const rows = await db
        .select({
          id: documents.id,
          name: documents.name,
          organizationId: documents.organizationId,
          updatedAt: documents.updatedAt,
          projectId: projects.id,
          projectName: projects.name,
        })
        .from(documents)
        .innerJoin(projects, eq(documents.projectId, projects.id))
        .where(inArray(documents.id, ids));
      const editable = await authz.bulkCheck(
        rows.map((row) => ({ resource: ref('document', row.id), permission: 'edit', subject })),
        consistency,
      );
      const names = new Map<string, string | undefined>();
      for (const organizationId of new Set(rows.map((row) => row.organizationId))) {
        const organization = await tenancy.getOrganization(user, organizationId);
        names.set(organizationId, organization?.name);
      }
      return rows
        .map((row, index) => ({
          id: row.id,
          name: row.name,
          project: { id: row.projectId, name: row.projectName },
          organization: { id: row.organizationId, name: names.get(row.organizationId) },
          canEdit: editable[index] ?? false,
          updatedAt: row.updatedAt,
        }))
        .sort(byPlace);
    },

    async getDocumentForEdit(user, id) {
      const row = await load(id);
      if (!row) throw new DocumentsError('not_found', 'document not found');
      const edit = await check(user, id, 'edit', atLeastAsFresh(row.zedtoken));
      if (!edit.allowed) throw await denied(user, row, atLeastAsFresh(row.zedtoken));
      return row;
    },

    async updateDocument(user, id, values) {
      const parsed = parseDocumentValues(values);
      const row = await load(id);
      if (!row) throw new DocumentsError('not_found', 'document not found');
      const edit = await check(user, id, 'edit', fullyConsistent);
      if (!edit.allowed) throw await denied(user, row, fullyConsistent);
      const [updated] = await db
        .update(documents)
        .set({
          value1: parsed.value1,
          value2: parsed.value2,
          zedtoken: edit.token,
          updatedAt: new Date(),
          updatedBy: user.sub,
        })
        .where(eq(documents.id, id))
        .returning();
      if (!updated) throw new DocumentsError('not_found', 'document not found');
      return updated;
    },
  };
}

function byPlace(a: VisibleDocument, b: VisibleDocument): number {
  return (
    compare(a.organization.name ?? a.organization.id, b.organization.name ?? b.organization.id) ||
    compare(a.project.name, b.project.name) ||
    compare(a.name, b.name) ||
    compare(a.id, b.id)
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SpiceDB may hold IDs that are not rows here (another environment's, a test's); never let one reach a uuid column. */
function isUuid(id: string): boolean {
  return UUID.test(id);
}
