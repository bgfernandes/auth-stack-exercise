import Link from 'next/link';
import { redirect } from 'next/navigation';

import { displayName, getCurrentUser } from '../../lib/current-user';
import { groupByPlace } from '../../lib/dashboard';
import { listDocuments } from '../../lib/documents';

import type { VisibleDocument } from '@auth-stack/documents/client';

interface Props {
  searchParams: Promise<{ saved?: string | string[] }>;
}

/**
 * The protected page (docs/README.md §6.5): every document the user may view, grouped by organization and
 * project, with "Edit" where the bulk check allowed `edit` and a read-only marker otherwise. The marker is a
 * hint: the edit page and the save route check again. `proxy.ts` sends a request without a session to the login;
 * this is the second check.
 */
export default async function DashboardPage({ searchParams }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect('/auth/login');
  const rows = await listDocuments();
  // A session whose token can no longer be refreshed: the user logs in again.
  if (!rows) redirect('/auth/login');
  const { saved } = await searchParams;
  const savedRow = typeof saved === 'string' ? rows.find((row) => row.id === saved) : undefined;
  const groups = groupByPlace(rows);
  return (
    <main>
      <h1>{`Welcome, ${displayName(user)}`}</h1>
      {saved !== undefined && (
        <p className="flash" role="status">
          {savedRow ? `Saved “${savedRow.name}”.` : 'Saved.'}
        </p>
      )}
      {groups.length === 0 && <p>No documents yet.</p>}
      {groups.map((organization) => (
        <section key={organization.id}>
          <h2>{`Organization: ${organization.name ?? 'not a member'}`}</h2>
          {organization.projects.map((project) => (
            <section key={project.id}>
              <h3>{`Project: ${project.name}`}</h3>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Document</th>
                    <th scope="col">Updated</th>
                    <th scope="col">Access</th>
                  </tr>
                </thead>
                <tbody>
                  {project.documents.map((document) => (
                    <DocumentRow key={document.id} document={document} />
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </section>
      ))}
    </main>
  );
}

function DocumentRow({ document }: { document: VisibleDocument }) {
  const updated = document.updatedAt.toISOString();
  return (
    <tr>
      <td>{document.name}</td>
      <td>
        <time dateTime={updated}>{`${updated.slice(0, 16).replace('T', ' ')} UTC`}</time>
      </td>
      <td>
        {document.canEdit ? (
          <Link href={`/documents/${document.id}/edit`}>Edit</Link>
        ) : (
          <span className="read-only" aria-disabled="true">
            Read-only
          </span>
        )}
      </td>
    </tr>
  );
}
