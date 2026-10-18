import { describe, expect, it } from '@jest/globals';

import { type VisibleDocument } from '@auth-stack/documents';

import { groupByPlace } from './dashboard';

function row(organization: string, project: string, name: string, canEdit = true): VisibleDocument {
  return {
    id: `${organization}-${project}-${name}`.toLowerCase(),
    name,
    project: { id: project.toLowerCase(), name: project },
    organization: { id: organization.toLowerCase(), name: organization },
    canEdit,
    updatedAt: new Date('2026-10-18T00:00:00Z'),
  };
}

describe('groupByPlace', () => {
  it('nests the listed rows under their organization and project, in the listed order', () => {
    const rows = [
      row('Acme', 'Finance', 'Payroll'),
      row('Acme', 'Marketing', 'Budget', false),
      row('Acme', 'Marketing', 'Launch plan'),
      row('Personal', 'Personal', 'Welcome'),
    ];
    const groups = groupByPlace(rows);
    expect(
      groups.map((organization) => [
        organization.name,
        organization.projects.map((project) => [
          project.name,
          project.documents.map((document) => document.name),
        ]),
      ]),
    ).toEqual([
      [
        'Acme',
        [
          ['Finance', ['Payroll']],
          ['Marketing', ['Budget', 'Launch plan']],
        ],
      ],
      ['Personal', [['Personal', ['Welcome']]]],
    ]);
    expect(groups[0]?.projects[1]?.documents[0]).toBe(rows[1]);
  });

  it('keeps an organization the user cannot see the name of as its own group', () => {
    const shared = {
      ...row('Elsewhere', 'Plans', 'Roadmap'),
      organization: { id: 'x', name: undefined },
    };
    expect(groupByPlace([shared])).toEqual([
      { id: 'x', name: undefined, projects: [{ id: 'plans', name: 'Plans', documents: [shared] }] },
    ]);
  });

  it('groups nothing into nothing', () => {
    expect(groupByPlace([])).toEqual([]);
  });
});
