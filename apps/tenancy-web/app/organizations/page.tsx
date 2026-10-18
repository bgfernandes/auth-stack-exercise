import Link from 'next/link';
import { redirect } from 'next/navigation';

import { displayName, getCurrentUser } from '../../lib/current-user';
import { listMyOrganizations } from '../../lib/organizations';

/**
 * The protected list (docs/README.md §6.6): every organization the user may view, from `tenancy-api`. The
 * personal one (§5.1) is marked as such; it has nothing to manage. `proxy.ts` sends a request without a session
 * to the login; this is the second check.
 */
export default async function OrganizationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/auth/login');
  const organizations = await listMyOrganizations();
  // A session whose token can no longer be refreshed: the user logs in again.
  if (!organizations) redirect('/auth/login');
  return (
    <main>
      <h1>{`Welcome, ${displayName(user)}`}</h1>
      {organizations.length === 0 && <p>You are not a member of any organization yet.</p>}
      {organizations.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Organization</th>
              <th scope="col">Kind</th>
            </tr>
          </thead>
          <tbody>
            {organizations.map((organization) => (
              <tr key={organization.id}>
                <td>
                  <Link href={`/organizations/${organization.id}`}>{organization.name}</Link>
                </td>
                <td>{organization.isPersonal ? 'Personal' : 'Shared'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
