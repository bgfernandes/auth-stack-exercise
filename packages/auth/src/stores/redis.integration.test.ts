/**
 * Against the compose Redis (`docker compose up -d --wait`; CI's integration job). Keys are prefixed per run, so
 * parallel runs and the apps' own sessions never meet, and the prefix is swept at the end.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Redis } from 'ioredis';

import { type SessionStore } from '../session';
import { describeSessionStoreContract } from '../session-store.contract';

import { createRedisSessionStore } from './redis';

// Not process.loadEnvFile: Jest gives each test file its own copy of `process.env`, and loadEnvFile writes to the real one.
function redisUrl(): string {
  const defaults = parseEnv(readFileSync(new URL('../../../../.env', import.meta.url), 'utf8'));
  const url = new URL(process.env.REDIS_URL ?? defaults.REDIS_URL ?? 'redis://localhost:6379');
  if (url.hostname === 'redis') url.hostname = 'localhost'; // the compose service name, from the host
  return url.toString();
}

const PREFIX = `it-auth-${randomUUID().slice(0, 8)}`;

async function sweep(client: Redis): Promise<void> {
  const keys = await client.keys(`${PREFIX}:*`);
  if (keys.length > 0) await client.del(...keys);
}

describeSessionStoreContract('redis', async (options) => {
  const client = new Redis(redisUrl());
  await sweep(client);
  return {
    store: createRedisSessionStore(client, { ...options, prefix: PREFIX }),
    close: async () => {
      await sweep(client);
      await client.quit();
    },
  };
});

describe('Redis specifics', () => {
  let client: Redis;
  let store: SessionStore;

  beforeAll(() => {
    client = new Redis(redisUrl());
    store = createRedisSessionStore(client, {
      prefix: `${PREFIX}-ttl`,
      limits: { idleSeconds: 60, absoluteSeconds: 600 },
    });
  });
  afterAll(async () => {
    const keys = await client.keys(`${PREFIX}-ttl:*`);
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  });

  const input = {
    sub: 'ttl-user',
    sid: 'ttl-sid',
    accessToken: 'at',
    accessTokenExpiresAt: Date.now() + 600_000,
    amr: ['pwd'],
  };

  it('sets the key TTL to the idle limit and maintains the two index sets', async () => {
    const session = await store.create(input);
    const key = `${PREFIX}-ttl:session:${session.id}`;
    expect(await client.ttl(key)).toBeGreaterThan(55);
    expect(await client.ttl(key)).toBeLessThanOrEqual(60);
    expect(await client.smembers(`${PREFIX}-ttl:sid:ttl-sid`)).toContain(session.id);
    expect(await client.smembers(`${PREFIX}-ttl:user:ttl-user`)).toContain(session.id);
    expect(await client.ttl(`${PREFIX}-ttl:user:ttl-user`)).toBeGreaterThan(590);
    await store.delete(session.id);
    expect(await client.exists(key)).toBe(0);
    expect(await client.smembers(`${PREFIX}-ttl:sid:ttl-sid`)).not.toContain(session.id);
    expect(await client.smembers(`${PREFIX}-ttl:user:ttl-user`)).not.toContain(session.id);
  });

  it('caps the TTL by the absolute limit', async () => {
    const short = createRedisSessionStore(client, {
      prefix: `${PREFIX}-ttl`,
      limits: { idleSeconds: 60, absoluteSeconds: 20 },
    });
    const session = await short.create(input);
    expect(await client.ttl(`${PREFIX}-ttl:session:${session.id}`)).toBeLessThanOrEqual(20);
    await short.touch(session.id);
    expect(await client.ttl(`${PREFIX}-ttl:session:${session.id}`)).toBeLessThanOrEqual(20);
  });

  it('prunes index entries whose session key expired on its own', async () => {
    const session = await store.create({ ...input, sub: 'ttl-user-pruned' });
    await client.del(`${PREFIX}-ttl:session:${session.id}`); // what the TTL does
    await expect(store.listByUser('ttl-user-pruned')).resolves.toEqual([]);
    expect(await client.smembers(`${PREFIX}-ttl:user:ttl-user-pruned`)).not.toContain(session.id);
  });
});
