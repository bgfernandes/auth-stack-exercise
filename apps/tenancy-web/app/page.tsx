import Link from 'next/link';

import { getCurrentUser } from '../lib/current-user';

/** The public landing page: a login link, or the way to the organizations list for a signed-in user. */
export default async function LandingPage() {
  const user = await getCurrentUser();
  return (
    <main>
      <h1>Organizations</h1>
      <p>
        Sign in with Zitadel to see your organizations, their members, and, as an administrator, to
        manage roles and the sign-in policy.
      </p>
      <p>
        {user ? (
          <Link href="/organizations">Go to your organizations</Link>
        ) : (
          <a href="/auth/login">Log in</a>
        )}
      </p>
    </main>
  );
}
