import Link from 'next/link';

import { displayName, getCurrentUser } from '../lib/current-user';

import type { ReactNode } from 'react';

import './globals.css';

export const metadata = { title: 'Organizations' };

// Every page reads the session, so none is prerendered: the build renders nothing and reads no configuration.
export const dynamic = 'force-dynamic';

/** The frame of every page: the app name, and who is signed in with the logout form, or the login link. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  return (
    <html lang="en">
      <body>
        <header>
          <Link href="/" className="brand">
            Organizations
          </Link>
          <nav>
            {user ? (
              <>
                <span>{displayName(user)}</span>
                <form method="post" action="/auth/logout">
                  <button type="submit">Log out</button>
                </form>
              </>
            ) : (
              <a href="/auth/login">Log in</a>
            )}
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
