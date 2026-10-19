/**
 * The server-side session and the `SessionStore` interface (docs/README.md §4.4): the browser holds an opaque
 * session ID, the store holds the tokens and the authentication evidence. Modelled on the `sessionStore` of
 * Auth0's `nextjs-auth0`: `update` and `touch` write only to a session that still exists and reset its idle
 * expiry, so a rolling write or a token refresh in flight during a logout never recreates what the logout
 * removed. There is no upsert.
 */
import { randomBytes } from 'node:crypto';

import type { LoginResult } from './oidc';

export interface Session {
  id: string;
  sub: string;
  email?: string;
  name?: string;
  /** The IdP session ID from the ID token; what a back-channel logout token names. */
  sid?: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Epoch milliseconds, like every timestamp here. */
  accessTokenExpiresAt: number;
  authTime?: number;
  amr: string[];
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
}

/** What `create` takes: the store assigns the ID and the timestamps. */
export type NewSession = Omit<Session, 'id' | 'createdAt' | 'lastSeenAt' | 'absoluteExpiresAt'>;

/** What a token refresh writes back. */
export type SessionPatch = Partial<
  Pick<Session, 'accessToken' | 'refreshToken' | 'idToken' | 'accessTokenExpiresAt'>
>;

export interface SessionLimits {
  /** A session unused for this long is gone: `get` refuses it and the Redis key expires. */
  idleSeconds: number;
  /**
   * A session older than this is gone whatever its activity; counted from the authentication the ID token
   * attests (`authTime`) when that is earlier than the session's creation, see `absoluteExpiresAt`.
   */
  absoluteSeconds: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  idleSeconds: 30 * 60,
  absoluteSeconds: 8 * 60 * 60,
};

export interface LogoutTokenClaims {
  sid?: string;
  sub?: string;
}

export interface SessionStore {
  create(session: NewSession): Promise<Session>;
  /** The session, unless unknown or past its idle or absolute limit (then it is removed). Does not touch. */
  get(id: string): Promise<Session | undefined>;
  /** Marks the session seen and resets its idle expiry; false when it no longer exists. One conditional operation. */
  touch(id: string): Promise<boolean>;
  /** Writes refreshed tokens and resets the idle expiry; false when it no longer exists. One conditional operation. */
  update(id: string, patch: SessionPatch): Promise<boolean>;
  delete(id: string): Promise<void>;
  /**
   * Back-channel logout: with `sid`, the sessions of that IdP session (and of that `sub`, when both are given);
   * with `sub` only, every session of the user. Returns how many were removed.
   */
  deleteByLogoutToken(claims: LogoutTokenClaims): Promise<number>;
  /** Admin revocation: every session of the user. */
  deleteByUser(sub: string): Promise<number>;
  listByUser(sub: string): Promise<Session[]>;
}

export interface SessionStoreOptions {
  limits?: Partial<SessionLimits>;
  /** Epoch milliseconds; injectable for the tests. */
  now?: () => number;
}

export function resolveLimits(limits: Partial<SessionLimits> | undefined): SessionLimits {
  return { ...DEFAULT_SESSION_LIMITS, ...limits };
}

/** 256 random bits, URL-safe. */
export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * When the absolute limit falls: `absoluteSeconds` from the earlier of the session's creation and the
 * authentication the ID token attests (`auth_time`, OpenID Connect Core 1.0 §2). A second app signed into through
 * SSO hours after the IdP login therefore shares the window of that login rather than opening a fresh one; a
 * token without `auth_time`, or one claiming a time after the creation, anchors at the creation.
 */
export function absoluteExpiresAt(
  session: Pick<NewSession, 'authTime'>,
  createdAt: number,
  limits: SessionLimits,
): number {
  return Math.min(createdAt, session.authTime ?? createdAt) + limits.absoluteSeconds * 1000;
}

export function isExpired(session: Session, limits: SessionLimits, now: number): boolean {
  return now >= session.absoluteExpiresAt || now - session.lastSeenAt >= limits.idleSeconds * 1000;
}

/** Seconds until the session expires if it is not touched again: the idle limit, capped by the absolute one. */
export function remainingSeconds(
  session: Pick<Session, 'absoluteExpiresAt'>,
  limits: SessionLimits,
  now: number,
): number {
  const untilAbsolute = Math.ceil((session.absoluteExpiresAt - now) / 1000);
  return Math.max(1, Math.min(limits.idleSeconds, untilAbsolute));
}

/** The session to create from a completed login. */
export function sessionFromLogin({ tokens, claims }: LoginResult): NewSession {
  const session: NewSession = {
    sub: claims.sub,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    amr: claims.amr,
  };
  if (claims.email !== undefined) session.email = claims.email;
  if (claims.name !== undefined) session.name = claims.name;
  if (claims.sid !== undefined) session.sid = claims.sid;
  if (claims.authTime !== undefined) session.authTime = claims.authTime;
  if (tokens.refreshToken !== undefined) session.refreshToken = tokens.refreshToken;
  if (tokens.idToken !== undefined) session.idToken = tokens.idToken;
  return session;
}
