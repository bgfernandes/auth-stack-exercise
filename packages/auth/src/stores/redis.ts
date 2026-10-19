/**
 * The Redis `SessionStore` (docs/README.md §4.4): a hash per session under `session:<id>` whose key TTL is the
 * idle limit capped by the absolute one, and two secondary sets the adapter maintains, `sid:<sid>` and
 * `user:<sub>`, for back-channel logout and per-user listing. Every write is one Lua script, so `create`,
 * `touch`, `update`, and `delete` are atomic and the conditional ones never recreate a deleted session. The only
 * dependency is an `ioredis`-compatible client handed in; the apps share one Redis, so each gives its store a
 * prefix.
 */
import {
  absoluteExpiresAt,
  isExpired,
  newSessionId,
  remainingSeconds,
  resolveLimits,
  type LogoutTokenClaims,
  type Session,
  type SessionPatch,
  type SessionStore,
  type SessionStoreOptions,
} from '../session';

/** The four commands the adapter uses, as `ioredis` exposes them. */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
}

export interface RedisSessionStoreOptions extends SessionStoreOptions {
  /** Prepended to every key (`<prefix>:session:<id>`); one per app, since the BFFs share one Redis. */
  prefix?: string;
}

// KEYS: session, user set, [sid set]. ARGV: id, session ttl, set ttl, then field/value pairs.
const CREATE = `
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], unpack(ARGV, 4))
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[3])
if #KEYS == 3 then
  redis.call('SADD', KEYS[3], ARGV[1])
  redis.call('EXPIRE', KEYS[3], ARGV[3])
end
return 1`;

// KEYS: session. ARGV: now (ms), idle seconds, then field/value pairs. Writes only to a live session, and
// recomputes the TTL from the absolute limit stored with it.
const UPDATE = `
local absolute = tonumber(redis.call('HGET', KEYS[1], 'absoluteExpiresAt'))
if absolute == nil then return 0 end
local now = tonumber(ARGV[1])
if absolute <= now then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('HSET', KEYS[1], unpack(ARGV, 3))
local ttl = math.min(tonumber(ARGV[2]), math.ceil((absolute - now) / 1000))
redis.call('EXPIRE', KEYS[1], math.max(1, ttl))
return 1`;

// KEYS: session. ARGV: id, user set prefix, sid set prefix. Removes the hash and its index entries together.
const DELETE = `
local sub = redis.call('HGET', KEYS[1], 'sub')
local sid = redis.call('HGET', KEYS[1], 'sid')
redis.call('DEL', KEYS[1])
if sub then redis.call('SREM', ARGV[2] .. sub, ARGV[1]) end
if sid then redis.call('SREM', ARGV[3] .. sid, ARGV[1]) end
return 1`;

const NUMBER_FIELDS = [
  'accessTokenExpiresAt',
  'authTime',
  'createdAt',
  'lastSeenAt',
  'absoluteExpiresAt',
] as const;
const STRING_FIELDS = [
  'sub',
  'email',
  'name',
  'sid',
  'accessToken',
  'refreshToken',
  'idToken',
] as const;

function encode(fields: Partial<Session>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out.push(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return out;
}

function decode(id: string, hash: Record<string, string>): Session | undefined {
  if (!hash.sub || !hash.accessToken) return undefined;
  const session: Record<string, unknown> = { id, amr: [] };
  for (const field of STRING_FIELDS) {
    if (hash[field] !== undefined) session[field] = hash[field];
  }
  for (const field of NUMBER_FIELDS) {
    const raw = hash[field];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) return undefined;
    session[field] = value;
  }
  if (hash.amr !== undefined) {
    try {
      const amr: unknown = JSON.parse(hash.amr);
      if (Array.isArray(amr)) session.amr = amr.filter((m): m is string => typeof m === 'string');
    } catch {
      return undefined;
    }
  }
  for (const field of [
    'accessTokenExpiresAt',
    'createdAt',
    'lastSeenAt',
    'absoluteExpiresAt',
  ] as const) {
    if (typeof session[field] !== 'number') return undefined;
  }
  return session as unknown as Session;
}

export function createRedisSessionStore(
  client: RedisLike,
  options: RedisSessionStoreOptions = {},
): SessionStore {
  const limits = resolveLimits(options.limits);
  const now = options.now ?? Date.now;
  const prefix = options.prefix ? `${options.prefix}:` : '';
  const sessionKey = (id: string) => `${prefix}session:${id}`;
  const userPrefix = `${prefix}user:`;
  const sidPrefix = `${prefix}sid:`;

  const remove = (id: string) => client.eval(DELETE, 1, sessionKey(id), id, userPrefix, sidPrefix);

  const get = async (id: string): Promise<Session | undefined> => {
    const session = decode(id, await client.hgetall(sessionKey(id)));
    if (!session) return undefined;
    if (isExpired(session, limits, now())) {
      await remove(id);
      return undefined;
    }
    return session;
  };

  /** The live sessions behind an index set; entries whose hash expired on its own are pruned on the way. */
  const liveMembers = async (setKey: string): Promise<Session[]> => {
    const result: Session[] = [];
    for (const id of await client.smembers(setKey)) {
      const session = await get(id);
      if (session) result.push(session);
      else await client.srem(setKey, id);
    }
    return result;
  };

  const removeAll = async (sessions: Session[]): Promise<number> => {
    for (const session of sessions) await remove(session.id);
    return sessions.length;
  };

  return {
    async create(input) {
      const createdAt = now();
      const session: Session = {
        ...input,
        id: newSessionId(),
        createdAt,
        lastSeenAt: createdAt,
        absoluteExpiresAt: absoluteExpiresAt(input, createdAt, limits),
      };
      const keys = [sessionKey(session.id), `${userPrefix}${session.sub}`];
      if (session.sid !== undefined) keys.push(`${sidPrefix}${session.sid}`);
      const { id, ...fields } = session;
      await client.eval(
        CREATE,
        keys.length,
        ...keys,
        id,
        remainingSeconds(session, limits, createdAt),
        limits.absoluteSeconds,
        ...encode(fields),
      );
      return session;
    },
    get,
    async touch(id) {
      const result = await client.eval(
        UPDATE,
        1,
        sessionKey(id),
        now(),
        limits.idleSeconds,
        ...encode({ lastSeenAt: now() }),
      );
      return result === 1;
    },
    async update(id, patch: SessionPatch) {
      const result = await client.eval(
        UPDATE,
        1,
        sessionKey(id),
        now(),
        limits.idleSeconds,
        ...encode({ ...patch, lastSeenAt: now() }),
      );
      return result === 1;
    },
    async delete(id) {
      await remove(id);
    },
    async deleteByLogoutToken({ sid, sub }: LogoutTokenClaims) {
      if (sid !== undefined) {
        const sessions = await liveMembers(`${sidPrefix}${sid}`);
        return removeAll(sub === undefined ? sessions : sessions.filter((s) => s.sub === sub));
      }
      if (sub !== undefined) return removeAll(await liveMembers(`${userPrefix}${sub}`));
      return 0;
    },
    async deleteByUser(sub) {
      return removeAll(await liveMembers(`${userPrefix}${sub}`));
    },
    async listByUser(sub) {
      return liveMembers(`${userPrefix}${sub}`);
    },
  };
}
