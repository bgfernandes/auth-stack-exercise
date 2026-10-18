/**
 * Who the request is for, read from the session once per request (React's `cache`, so the layout, the page,
 * and the domain calls share one store read). Components get `getCurrentUser()`, without the tokens; the
 * server code that calls the domain and the APIs (`lib/documents.ts`) gets `getCurrentUserContext()`, the
 * `sub` with a live access token, and nothing renders it.
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
 * The user as the domain and the APIs see them; undefined without a session, or when the session's access token
 * is expired and cannot be refreshed, in which case the user has to log in again.
 */
export const getCurrentUserContext = cache(async (): Promise<UserContext | undefined> => {
  const session = await currentSession();
  if (!session) return undefined;
  const accessToken = await auth().getAccessToken(session);
  return accessToken ? { sub: session.sub, accessToken } : undefined;
});

/** What the pages greet the user by: the name from the ID token, the email, or the subject. */
export function displayName(user: CurrentUser): string {
  return user.name ?? user.email ?? user.sub;
}
