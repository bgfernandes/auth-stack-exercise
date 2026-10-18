import { redirect } from 'next/navigation';

import { displayName, getCurrentUser } from '../../lib/current-user';

/** The protected page: `proxy.ts` sends a request without a session to the login; this is the second check. */
export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/auth/login');
  return (
    <main>
      <h1>{`Welcome, ${displayName(user)}`}</h1>
      <p>Your documents appear here once the dashboard lands (ticket 11).</p>
    </main>
  );
}
