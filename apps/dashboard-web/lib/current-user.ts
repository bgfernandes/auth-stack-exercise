/**
 * `getCurrentUser()`: who the request is for, read from the session once per request (React's `cache`, so the
 * layout and the page share one store read), without the tokens, which stay in the session for the server code
 * that calls the APIs (`auth().getAccessToken`).
 */
import { cache } from 'react';

import { auth } from './auth';

export interface CurrentUser {
  sub: string;
  email: string | undefined;
  name: string | undefined;
}

export const getCurrentUser = cache(async (): Promise<CurrentUser | undefined> => {
  const session = await auth().currentSession();
  if (!session) return undefined;
  return { sub: session.sub, email: session.email, name: session.name };
});

/** What the pages greet the user by: the name from the ID token, the email, or the subject. */
export function displayName(user: CurrentUser): string {
  return user.name ?? user.email ?? user.sub;
}
