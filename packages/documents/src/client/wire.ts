/**
 * The wire format of `dashboard-api` (ticket 19a): snake_case JSON like `tenancy-api`'s, with dates as ISO
 * strings, produced on the way out by the API and parsed on the way in by the HTTP client from the same
 * definitions, so the two cannot drift apart. The request bodies carry their shape only; the service owns the
 * constraints (lengths, membership) and the API answers `400` from its `ZodError`.
 */
import { z } from 'zod';

import type {
  DocumentSummary,
  PersonalWorkspaceSummary,
  ProjectSummary,
  VisibleDocument,
} from './index';

export const documentWire = z
  .object({
    id: z.uuid(),
    project_id: z.uuid(),
    organization_id: z.uuid(),
    name: z.string(),
    value_1: z.string(),
    value_2: z.string(),
    updated_at: z.iso.datetime(),
    updated_by: z.string(),
  })
  .strict();

export type DocumentWire = z.infer<typeof documentWire>;

export const visibleDocumentWire = z
  .object({
    id: z.uuid(),
    name: z.string(),
    project: z.object({ id: z.uuid(), name: z.string() }).strict(),
    organization: z.object({ id: z.uuid(), name: z.string().nullable() }).strict(),
    can_edit: z.boolean(),
    updated_at: z.iso.datetime(),
  })
  .strict();

export type VisibleDocumentWire = z.infer<typeof visibleDocumentWire>;

/** `GET /documents` */
export const documentsWire = z.object({ documents: z.array(visibleDocumentWire) });

export type DocumentsWire = z.infer<typeof documentsWire>;

export const projectWire = z
  .object({
    id: z.uuid(),
    organization_id: z.uuid(),
    name: z.string(),
    is_personal: z.boolean(),
    created_at: z.iso.datetime(),
  })
  .strict();

export type ProjectWire = z.infer<typeof projectWire>;

/** `POST /organizations/:id/personal-project` */
export const personalWorkspaceWire = z.object({
  project: projectWire,
  document: documentWire,
  created: z.boolean(),
});

export type PersonalWorkspaceWire = z.infer<typeof personalWorkspaceWire>;

/** The body of `PUT /documents/:id`. */
export const documentValuesWire = z.object({ value_1: z.string(), value_2: z.string() }).strict();

export type DocumentValuesWire = z.infer<typeof documentValuesWire>;

/** The body of `PUT /documents/:id/shares`: the whole set of direct shares, by member ID (§6.8). */
export const documentSharesWire = z
  .object({ editors: z.array(z.string()), viewers: z.array(z.string()) })
  .strict();

export type DocumentSharesWire = z.infer<typeof documentSharesWire>;

export function toDocumentWire(document: DocumentSummary): DocumentWire {
  return {
    id: document.id,
    project_id: document.projectId,
    organization_id: document.organizationId,
    name: document.name,
    value_1: document.value1,
    value_2: document.value2,
    updated_at: document.updatedAt.toISOString(),
    updated_by: document.updatedBy,
  };
}

export function fromDocumentWire(wire: DocumentWire): DocumentSummary {
  return {
    id: wire.id,
    projectId: wire.project_id,
    organizationId: wire.organization_id,
    name: wire.name,
    value1: wire.value_1,
    value2: wire.value_2,
    updatedAt: new Date(wire.updated_at),
    updatedBy: wire.updated_by,
  };
}

export function toVisibleDocumentWire(row: VisibleDocument): VisibleDocumentWire {
  return {
    id: row.id,
    name: row.name,
    project: { id: row.project.id, name: row.project.name },
    organization: { id: row.organization.id, name: row.organization.name ?? null },
    can_edit: row.canEdit,
    updated_at: row.updatedAt.toISOString(),
  };
}

export function fromVisibleDocumentWire(wire: VisibleDocumentWire): VisibleDocument {
  return {
    id: wire.id,
    name: wire.name,
    project: { id: wire.project.id, name: wire.project.name },
    organization: { id: wire.organization.id, name: wire.organization.name ?? undefined },
    canEdit: wire.can_edit,
    updatedAt: new Date(wire.updated_at),
  };
}

function toProjectWire(project: ProjectSummary): ProjectWire {
  return {
    id: project.id,
    organization_id: project.organizationId,
    name: project.name,
    is_personal: project.isPersonal,
    created_at: project.createdAt.toISOString(),
  };
}

function fromProjectWire(wire: ProjectWire): ProjectSummary {
  return {
    id: wire.id,
    organizationId: wire.organization_id,
    name: wire.name,
    isPersonal: wire.is_personal,
    createdAt: new Date(wire.created_at),
  };
}

export function toPersonalWorkspaceWire(
  workspace: PersonalWorkspaceSummary,
): PersonalWorkspaceWire {
  return {
    project: toProjectWire(workspace.project),
    document: toDocumentWire(workspace.document),
    created: workspace.created,
  };
}

export function fromPersonalWorkspaceWire(wire: PersonalWorkspaceWire): PersonalWorkspaceSummary {
  return {
    project: fromProjectWire(wire.project),
    document: fromDocumentWire(wire.document),
    created: wire.created,
  };
}
