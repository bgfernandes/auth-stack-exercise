/** The dashboard's shape (docs/README.md §6.5): one row per document, grouped by organization and project. */
import { type VisibleDocument } from '@auth-stack/documents';

export interface ProjectGroup {
  id: string;
  name: string;
  documents: VisibleDocument[];
}

export interface OrganizationGroup {
  id: string;
  /** Undefined when tenancy does not show the organization to the user (a direct share from elsewhere). */
  name: string | undefined;
  projects: ProjectGroup[];
}

/** Groups the rows in the order the service listed them (by organization, project, and document name). */
export function groupByPlace(rows: VisibleDocument[]): OrganizationGroup[] {
  const groups: OrganizationGroup[] = [];
  for (const row of rows) {
    let organization = groups.at(-1);
    if (organization?.id !== row.organization.id) {
      organization = { ...row.organization, projects: [] };
      groups.push(organization);
    }
    let project = organization.projects.at(-1);
    if (project?.id !== row.project.id) {
      project = { ...row.project, documents: [] };
      organization.projects.push(project);
    }
    project.documents.push(row);
  }
  return groups;
}
