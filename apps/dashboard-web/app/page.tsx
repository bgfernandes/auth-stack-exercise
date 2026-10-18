import Link from 'next/link';

import { getCurrentUser } from '../lib/current-user';

/** The public landing page: a login link, or the way to the dashboard for a signed-in user. */
export default async function LandingPage() {
  const user = await getCurrentUser();
  return (
    <main>
      <h1>Documents</h1>
      <p>Sign in with Zitadel to see the documents you can view and edit the ones you can edit.</p>
      <p>
        {user ? (
          <Link href="/dashboard">Go to the dashboard</Link>
        ) : (
          <a href="/auth/login">Log in</a>
        )}
      </p>
    </main>
  );
}
