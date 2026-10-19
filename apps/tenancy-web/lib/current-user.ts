/**
 * Who the request is for, read from the session once per request (React's `cache`, so the layout, the page,
 * and the API calls share one store read). Components get `getCurrentUser()`, without the tokens; the server
 * code that calls `tenancy-api` (`lib/organizations.ts`, the route handlers) gets `getCurrentUserContext()`,
 * the `sub` with a live access token, and nothing renders it.
 */
import { cache } from 'react';

import { type UserContext } from '@auth-stack/tenancy/client';

import { auth } from './auth';

export interface CurrentUser {
  sub: string;
  email: string | undefined;
  name: string | undefined;
}

const currentSession = cache(() => auth().currentSession());

export const getCurrentUser = cache(async (): Promise<CurrentUser | undefined> => {
  const session = await currentSession();
  if (!session) return undefined;
  return { sub: session.sub, email: session.email, name: session.name };
});

/**
 * The user as the API sees them; undefined without a session, or when the session's access token is expired
 * and cannot be refreshed, in which case the user has to log in again.
 */
export const getCurrentUserContext = cache(async (): Promise<UserContext | undefined> => {
  const session = await currentSession();
  if (!session) return undefined;
  const accessToken = await auth().getAccessToken(session);
  return accessToken ? { sub: session.sub, accessToken } : undefined;
});

/** The session's synchronizer token for the forms (docs/README.md §9, "CSRF"); undefined without a session. */
export const getCsrfToken = cache(async (): Promise<string | undefined> => {
  const session = await currentSession();
  return session && auth().csrfTokenOf(session);
});

/** Whether a posted form's `csrf_token` is the session's; false without a session. */
export async function verifyCsrfToken(presented: unknown): Promise<boolean> {
  const session = await currentSession();
  return session !== undefined && auth().verifyCsrfToken(session, presented);
}

/** What the pages greet the user by: the name from the ID token, the email, or the subject. */
export function displayName(user: CurrentUser): string {
  return user.name ?? user.email ?? user.sub;
}
