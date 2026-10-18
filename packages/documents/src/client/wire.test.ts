/** The wire format round-trips, and what the API produces is what the client's schemas accept. */
import { describe, expect, it } from '@jest/globals';

import {
  documentsWire,
  documentWire,
  fromDocumentWire,
  fromPersonalWorkspaceWire,
  fromVisibleDocumentWire,
  personalWorkspaceWire,
  toDocumentWire,
  toPersonalWorkspaceWire,
  toVisibleDocumentWire,
  type DocumentSummary,
  type PersonalWorkspaceSummary,
  type VisibleDocument,
} from './index';

const at = new Date('2026-10-18T10:00:00.000Z');
const document: DocumentSummary = {
  id: '5eed0000-0000-4000-8000-000000000001',
  projectId: '5eed0000-0000-4000-8000-000000000002',
  organizationId: '5eed0000-0000-4000-8000-000000000003',
  name: 'Budget',
  value1: 'Approved spend',
  value2: '120000',
  updatedAt: at,
  updatedBy: '123456789',
};

describe('the documents wire format', () => {
  it('round-trips a document, with the date as an ISO string and no token', () => {
    const wire = toDocumentWire({ ...document, zedtoken: 'secret' } as DocumentSummary);
    expect(wire).toEqual({
      id: document.id,
      project_id: document.projectId,
      organization_id: document.organizationId,
      name: 'Budget',
      value_1: 'Approved spend',
      value_2: '120000',
      updated_at: '2026-10-18T10:00:00.000Z',
      updated_by: '123456789',
    });
    expect(documentWire.parse(wire)).toEqual(wire);
    expect(fromDocumentWire(wire)).toEqual(document);
  });

  it('round-trips a listing, with a missing organization name as null', () => {
    const rows: VisibleDocument[] = [
      {
        id: document.id,
        name: 'Budget',
        project: { id: document.projectId, name: 'Marketing' },
        organization: { id: document.organizationId, name: 'Acme' },
        canEdit: false,
        updatedAt: at,
      },
      {
        id: '5eed0000-0000-4000-8000-000000000004',
        name: 'Welcome',
        project: { id: '5eed0000-0000-4000-8000-000000000005', name: 'Personal' },
        organization: { id: '5eed0000-0000-4000-8000-000000000006', name: undefined },
        canEdit: true,
        updatedAt: at,
      },
    ];
    const wire = { documents: rows.map(toVisibleDocumentWire) };
    expect(wire.documents[1]?.organization).toEqual({
      id: '5eed0000-0000-4000-8000-000000000006',
      name: null,
    });
    expect(wire.documents[0]).toMatchObject({ can_edit: false, updated_at: at.toISOString() });
    expect(documentsWire.parse(wire).documents.map(fromVisibleDocumentWire)).toEqual(rows);
  });

  it('round-trips the personal workspace', () => {
    const workspace: PersonalWorkspaceSummary = {
      project: {
        id: document.projectId,
        organizationId: document.organizationId,
        name: 'Personal',
        isPersonal: true,
        createdAt: at,
      },
      document,
      created: true,
    };
    const wire = toPersonalWorkspaceWire(workspace);
    expect(wire.project).toEqual({
      id: document.projectId,
      organization_id: document.organizationId,
      name: 'Personal',
      is_personal: true,
      created_at: at.toISOString(),
    });
    expect(fromPersonalWorkspaceWire(personalWorkspaceWire.parse(wire))).toEqual(workspace);
  });

  it('refuses what is not on the wire', () => {
    expect(documentWire.safeParse({ ...toDocumentWire(document), zedtoken: 'x' }).success).toBe(
      false,
    );
    expect(
      documentWire.safeParse({ ...toDocumentWire(document), updated_at: 'today' }).success,
    ).toBe(false);
  });
});
