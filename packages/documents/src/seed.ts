/**
 * Seeding (docs/README.md §6.3): projects and documents under an organization that tenancy seeded, with the
 * structural relationships that make the schema's arrows fire (§6.2), the project roles, and the direct document
 * shares, written by bootstrap, which is trusted and has no principal to check. Every ID comes from the caller
 * so a test can seed a scenario of its own; the Acme constants live in bootstrap. Idempotent: rows are created
 * if absent and their content is never changed afterwards, every relationship is TOUCHed on every run, and the
 * write's token replaces each seeded document's `zedtoken` (§7.3: a grant stores its token on the rows it
 * affects, so the edit page's read, at least as fresh as the row, sees a role repaired by this run).
 */
import { inArray } from 'drizzle-orm';

import {
  ref,
  relationship,
  touch,
  type Authz,
  type RelationshipUpdate,
  type ZedToken,
} from '@auth-stack/authz';

import { documents, projects } from './schema';
import { type DocumentsDb } from './service';

export interface ProjectSeed {
  /** A fixed UUID, so reruns match the same row. */
  id: string;
  name: string;
  /** `project#<role>@user:<sub>` for each, TOUCHed on every run. */
  roles?: { sub: string; role: 'owner' | 'editor' | 'viewer' }[];
}

export interface DocumentSeed {
  /** A fixed UUID, so reruns match the same row. */
  id: string;
  /** One of the seed's projects. */
  projectId: string;
  name: string;
  value1: string;
  value2: string;
  /** `document#<role>@user:<sub>` for each, TOUCHed on every run: the direct shares of §6.3. */
  roles?: { sub: string; role: 'editor' | 'viewer' }[];
}

export interface DocumentsSeed {
  /** The tenancy organization the projects belong to; seeded first, so its roles are older than this write. */
  organizationId: string;
  /** The `sub` recorded as the creator (`updated_by`) of the documents this run creates. */
  createdBy: string;
  projects: ProjectSeed[];
  documents: DocumentSeed[];
}

export interface DocumentsSeedOutcome {
  /** The IDs of the projects this run created. */
  createdProjects: string[];
  /** The IDs of the documents this run created; every seeded document carries `token` afterwards. */
  createdDocuments: string[];
  /** The token of the relationship write, stored on every seeded document. */
  token: ZedToken;
}

export async function seedDocuments(
  deps: { db: DocumentsDb; authz: Authz },
  seed: DocumentsSeed,
): Promise<DocumentsSeedOutcome> {
  const { db, authz } = deps;
  const updates = relationshipsOf(seed);
  return db.transaction(async (tx) => {
    const createdProjects = (
      await tx
        .insert(projects)
        .values(
          seed.projects.map((project) => ({
            id: project.id,
            organizationId: seed.organizationId,
            name: project.name,
          })),
        )
        .onConflictDoNothing({ target: projects.id })
        .returning({ id: projects.id })
    ).map((row) => row.id);
    // Inside the transaction: if SpiceDB refuses, the rows roll back and the next run starts over.
    const token = await authz.writeRelationships(updates);
    const existing = new Set(
      (
        await tx
          .select({ id: documents.id })
          .from(documents)
          .where(
            inArray(
              documents.id,
              seed.documents.map((document) => document.id),
            ),
          )
      ).map((row) => row.id),
    );
    await tx
      .insert(documents)
      .values(
        seed.documents.map((document) => ({
          id: document.id,
          projectId: document.projectId,
          organizationId: seed.organizationId,
          name: document.name,
          value1: document.value1,
          value2: document.value2,
          zedtoken: token,
          updatedBy: seed.createdBy,
        })),
      )
      // An existing document keeps its values and its writer; only the permission snapshot moves forward.
      .onConflictDoUpdate({ target: documents.id, set: { zedtoken: token } });
    return {
      createdProjects,
      createdDocuments: seed.documents
        .map((document) => document.id)
        .filter((id) => !existing.has(id)),
      token,
    };
  });
}

/** Every relationship of the scenario; `ref` throws on an ID SpiceDB would refuse, before anything is written. */
function relationshipsOf(seed: DocumentsSeed): RelationshipUpdate[] {
  const organization = ref('organization', seed.organizationId);
  const projectIds = new Set(seed.projects.map((project) => project.id));
  const updates: RelationshipUpdate[] = [];
  for (const project of seed.projects) {
    const resource = ref('project', project.id);
    updates.push(touch(relationship(resource, 'organization', organization)));
    for (const { sub, role } of project.roles ?? []) {
      updates.push(touch(relationship(resource, role, ref('user', sub))));
    }
  }
  for (const document of seed.documents) {
    if (!projectIds.has(document.projectId)) {
      throw new Error(
        `document ${document.id} names a project the seed does not: ${document.projectId}`,
      );
    }
    const resource = ref('document', document.id);
    updates.push(touch(relationship(resource, 'project', ref('project', document.projectId))));
    for (const { sub, role } of document.roles ?? []) {
      updates.push(touch(relationship(resource, role, ref('user', sub))));
    }
  }
  return updates;
}
