/**
 * The in-memory `SessionStore`: tests and single-process development. Same limits and semantics as the Redis
 * adapter, including that `touch` and `update` write only to an existing session; nothing persists.
 */
import {
  absoluteExpiresAt,
  isExpired,
  newSessionId,
  resolveLimits,
  type LogoutTokenClaims,
  type Session,
  type SessionPatch,
  type SessionStore,
  type SessionStoreOptions,
} from '../session';

export function createMemorySessionStore(options: SessionStoreOptions = {}): SessionStore {
  const limits = resolveLimits(options.limits);
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Session>();

  const live = (id: string): Session | undefined => {
    const session = sessions.get(id);
    if (!session) return undefined;
    if (isExpired(session, limits, now())) {
      sessions.delete(id);
      return undefined;
    }
    return session;
  };

  const remove = (predicate: (session: Session) => boolean): number => {
    let removed = 0;
    for (const [id, session] of sessions) {
      if (predicate(session)) {
        sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  };

  return {
    create(input) {
      const createdAt = now();
      const session: Session = {
        ...input,
        id: newSessionId(),
        createdAt,
        lastSeenAt: createdAt,
        absoluteExpiresAt: absoluteExpiresAt(input, createdAt, limits),
      };
      sessions.set(session.id, session);
      return Promise.resolve({ ...session });
    },
    get(id) {
      const session = live(id);
      return Promise.resolve(session ? { ...session } : undefined);
    },
    touch(id) {
      const session = live(id);
      if (session) session.lastSeenAt = now();
      return Promise.resolve(session !== undefined);
    },
    update(id, patch: SessionPatch) {
      const session = live(id);
      if (session) Object.assign(session, patch, { lastSeenAt: now() });
      return Promise.resolve(session !== undefined);
    },
    delete(id) {
      sessions.delete(id);
      return Promise.resolve();
    },
    deleteByLogoutToken({ sid, sub }: LogoutTokenClaims) {
      if (sid !== undefined) {
        const known = [...sessions.keys()].some((id) => live(id)?.sid === sid);
        if (known || sub === undefined) {
          return Promise.resolve(
            remove((s) => s.sid === sid && (sub === undefined || s.sub === sub)),
          );
        }
        // No live session of that IdP session, but the token names the user: every session of theirs goes.
      }
      return Promise.resolve(sub === undefined ? 0 : remove((s) => s.sub === sub));
    },
    deleteByUser(sub) {
      return Promise.resolve(remove((s) => s.sub === sub));
    },
    listByUser(sub) {
      const result: Session[] = [];
      for (const id of [...sessions.keys()]) {
        const session = live(id);
        if (session?.sub === sub) result.push({ ...session });
      }
      return Promise.resolve(result);
    },
  };
}
