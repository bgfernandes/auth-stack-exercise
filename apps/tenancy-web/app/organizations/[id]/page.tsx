import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { organizationView } from '../../../lib/organizations';

import type { Member, OrganizationSummary, Policy } from '@auth-stack/tenancy/client';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string | string[]; error?: string | string[] }>;
}

/**
 * One organization (ticket 17): the member list every member sees (docs/README.md §6.8), and, for an
 * administrator, the role buttons next to each row and the policy form (§9.1). The buttons and the form are
 * hints drawn from the caller's own role: the write routes send every change to `tenancy-api`, which decides.
 * A personal organization (§5.1) shows neither: it has no members to manage and no policy.
 */
export default async function OrganizationPage({ params, searchParams }: Props) {
  const { id } = await params;
  const view = await organizationView(id);
  if (view.state === 'unauthenticated') redirect('/auth/login');
  if (view.state === 'not_found') notFound();
  const { organization, members, callerRole } = view;
  const { saved, error } = await searchParams;
  const manages = callerRole === 'admin' && !organization.isPersonal;
  return (
    <main>
      <p>
        <Link href="/organizations">Back to your organizations</Link>
      </p>
      <h1>{organization.name}</h1>
      {typeof saved === 'string' && (
        <p className="flash" role="status">
          {saved === 'policy' ? 'Policy saved.' : 'Member list updated.'}
        </p>
      )}
      {typeof error === 'string' && (
        <p className="error" role="alert">
          {errorMessage(error)}
        </p>
      )}
      {organization.isPersonal ? (
        <p>
          Your personal organization: it holds your personal project, has no members to manage, and
          sets no sign-in policy.
        </p>
      ) : (
        <>
          <section aria-labelledby="members">
            <h2 id="members">Members</h2>
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  {manages && <th scope="col">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <MemberRow
                    key={member.sub}
                    organizationId={organization.id}
                    member={member}
                    manages={manages}
                  />
                ))}
              </tbody>
            </table>
            <p className="read-only">
              New members join by invitation; there is no form to add one by email or by ID.
            </p>
          </section>
          <section aria-labelledby="policy">
            <h2 id="policy">Sign-in policy</h2>
            {manages ? (
              <PolicyForm organization={organization} />
            ) : (
              <PolicySummary policy={organization.policy} />
            )}
          </section>
        </>
      )}
    </main>
  );
}

function MemberRow({
  organizationId,
  member,
  manages,
}: {
  organizationId: string;
  member: Member;
  manages: boolean;
}) {
  return (
    <tr>
      <td>{member.displayName ?? member.sub}</td>
      <td>{member.email ?? ''}</td>
      <td>{member.role === 'admin' ? 'Administrator' : 'Member'}</td>
      {manages && (
        <td>
          <form
            method="post"
            action={`/organizations/${organizationId}/members`}
            className="inline"
          >
            <input type="hidden" name="member_id" value={member.sub} />
            {member.role === 'admin' ? (
              <button type="submit" name="role" value="member">
                Make member
              </button>
            ) : (
              <button type="submit" name="role" value="admin">
                Make administrator
              </button>
            )}{' '}
            <button type="submit" name="role" value="remove">
              Remove
            </button>
          </form>
        </td>
      )}
    </tr>
  );
}

function PolicyForm({ organization }: { organization: OrganizationSummary }) {
  const { policy } = organization;
  return (
    <form method="post" action={`/organizations/${organization.id}/policy`}>
      <p>
        <label>
          <input type="checkbox" name="require_mfa" defaultChecked={policy.require_mfa === true} />{' '}
          Require multi-factor authentication
        </label>
      </p>
      <p>
        <label htmlFor="max_auth_age_seconds">
          Maximum login age, in seconds (empty: no limit)
        </label>
        <input
          id="max_auth_age_seconds"
          name="max_auth_age_seconds"
          type="number"
          min={1}
          step={1}
          defaultValue={policy.max_auth_age_seconds ?? ''}
        />
      </p>
      <p>
        <label htmlFor="require_idp">
          Required identity provider (a Zitadel IdP ID; empty: any)
        </label>
        <input id="require_idp" name="require_idp" defaultValue={policy.require_idp ?? ''} />
      </p>
      <button type="submit">Save policy</button>
    </form>
  );
}

function PolicySummary({ policy }: { policy: Policy }) {
  const floors = [
    policy.require_mfa ? 'multi-factor authentication required' : undefined,
    policy.max_auth_age_seconds !== undefined
      ? `login at most ${policy.max_auth_age_seconds} seconds old`
      : undefined,
    policy.require_idp !== undefined
      ? `login through identity provider ${policy.require_idp}`
      : undefined,
  ].filter((floor): floor is string => floor !== undefined);
  return (
    <p>
      {floors.length === 0
        ? 'No sign-in floors are set. Only an administrator can change the policy.'
        : `Floors: ${floors.join('; ')}. Only an administrator can change the policy.`}
    </p>
  );
}

function errorMessage(code: string): string {
  switch (code) {
    case 'not_a_member':
      return 'That user is no longer a member of the organization. Nothing was changed.';
    case 'last_admin':
      return 'An organization keeps at least one administrator. Nothing was changed.';
    case 'personal_organization':
      return 'A personal organization has no members to manage. Nothing was changed.';
    case 'invalid_input':
      return 'The values were not accepted. Nothing was saved.';
    default:
      return 'The change was not accepted. Nothing was changed.';
  }
}
