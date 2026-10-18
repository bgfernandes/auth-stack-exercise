/**
 * `@auth-stack/documents/client`: what a caller of `dashboard-api` needs and nothing from the package root (no
 * schema, no database), in the shape of `@auth-stack/tenancy/client` (docs/README.md §3.1): the API's scope
 * vocabulary, its wire format, and the types a BFF works with. The HTTP client itself arrives with ticket 19,
 * when `dashboard-web` stops calling the service in-process.
 */
export {
  documentSharesWire,
  documentsWire,
  documentValuesWire,
  documentWire,
  fromDocumentWire,
  fromPersonalWorkspaceWire,
  fromVisibleDocumentWire,
  personalWorkspaceWire,
  projectWire,
  toDocumentWire,
  toPersonalWorkspaceWire,
  toVisibleDocumentWire,
  visibleDocumentWire,
  type DocumentSharesWire,
  type DocumentsWire,
  type DocumentValuesWire,
  type DocumentWire,
  type PersonalWorkspaceWire,
  type ProjectWire,
  type VisibleDocumentWire,
} from './wire';

/**
 * The scope vocabulary of `dashboard-api` (docs/README.md §6.7): what its routes require and what bootstrap
 * grants to every first-party client that calls it.
 */
export const DOCUMENTS_API_SCOPES = {
  read: 'documents:read',
  write: 'documents:write',
} as const;

/** A document as a caller sees it: the row without its permission snapshot (`zedtoken`), which is the service's. */
export interface DocumentSummary {
  id: string;
  projectId: string;
  organizationId: string;
  name: string;
  value1: string;
  value2: string;
  updatedAt: Date;
  /** The `sub` of the last writer. */
  updatedBy: string;
}

export interface ProjectSummary {
  id: string;
  organizationId: string;
  name: string;
  isPersonal: boolean;
  createdAt: Date;
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

/** The personal workspace (§6.4) as `POST /organizations/:id/personal-project` answers it. */
export interface PersonalWorkspaceSummary {
  project: ProjectSummary;
  document: DocumentSummary;
  /** Whether this call created them; false on every call after the first. */
  created: boolean;
}
