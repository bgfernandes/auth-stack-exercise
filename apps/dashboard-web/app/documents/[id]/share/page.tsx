import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { CSRF_FIELD } from '@auth-stack/auth';

import { getCsrfToken } from '../../../../lib/current-user';
import { documentForShare } from '../../../../lib/documents';

import type { Member } from '@auth-stack/tenancy/client';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
}

type Role = 'none' | 'viewer' | 'editor';

/**
 * The share form (docs/README.md §6.8): the members of the organization that owns the document, each with the
 * direct access they hold on it, none, viewer, or editor, as the API read them at the row's token (§7.3); shown
 * only to a user with `document#share`. Project roles are not shown or changed here: a project editor keeps
 * editing whatever this form says. The form posts the whole set to `POST /documents/:id/shares` with the
 * session's synchronizer token (§9, "CSRF").
 */
export default async function ShareDocumentPage({ params, searchParams }: Props) {
  const { id } = await params;
  const result = await documentForShare(id);
  if (result.state === 'unauthenticated') redirect('/auth/login');
  if (result.state === 'not_found') notFound();
  if (result.state === 'forbidden') return <Forbidden />;
  const { document, shares, members } = result;
  const { error } = await searchParams;
  const csrfToken = await getCsrfToken();
  const roleOf = (member: Member): Role =>
    shares.editors.includes(member.sub)
      ? 'editor'
      : shares.viewers.includes(member.sub)
        ? 'viewer'
        : 'none';
  return (
    <main>
      <p>
        <Link href="/dashboard">Back to the dashboard</Link>
      </p>
      <h1>{`Share “${document.name}”`}</h1>
      <p>
        Direct access for members of the organization. Roles on the project are not shown here and
        are not changed by this form.
      </p>
      {error !== undefined && (
        <p className="error" role="alert">
          One of the chosen members is no longer a member of the organization. Nothing was saved.
        </p>
      )}
      {members.length === 0 ? (
        <p>Nobody to share with: you are the only member of this organization.</p>
      ) : (
        <form method="post" action={`/documents/${document.id}/shares`}>
          <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
          <table>
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Organization role</th>
                <th scope="col">Access</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <MemberRow key={member.sub} member={member} role={roleOf(member)} />
              ))}
            </tbody>
          </table>
          <button type="submit">Save</button>
        </form>
      )}
    </main>
  );
}

const ROLES: { value: Role; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
];

function MemberRow({ member, role }: { member: Member; role: Role }) {
  const label = member.displayName ?? member.email ?? member.sub;
  return (
    <tr>
      <td>{label}</td>
      <td>{member.role}</td>
      <td>
        {ROLES.map((option) => (
          <label key={option.value} className="choice">
            <input
              type="radio"
              name={`role:${member.sub}`}
              value={option.value}
              defaultChecked={option.value === role}
            />{' '}
            {option.label}
          </label>
        ))}
      </td>
    </tr>
  );
}

function Forbidden() {
  return (
    <main>
      <h1>Not yours to share</h1>
      <p>You can view this document but not share it.</p>
      <p>
        <Link href="/dashboard">Back to the dashboard</Link>
      </p>
    </main>
  );
}
