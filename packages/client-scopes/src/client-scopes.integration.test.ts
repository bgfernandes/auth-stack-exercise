/**
 * Against the compose SpiceDB (`docker compose up -d --wait`; CI's integration job): grants written for a
 * client of this run only, resolved through the real lookup, removed afterwards.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import {
  authzOptionsFromEnv,
  createAuthz,
  fullyConsistent,
  relationship,
  touch,
  type Authz,
} from '@auth-stack/authz';
import { ensureSchema } from '@auth-stack/authz/schema';

import { apiScope, client, createScopeResolver } from './index';

function loadStackDefaults(): void {
  const defaults = parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8'));
  for (const key of ['SPICEDB_PRESHARED_KEY', 'SPICEDB_INSECURE'])
    process.env[key] ??= defaults[key];
  process.env.SPICEDB_ENDPOINT ??= 'localhost:50051';
}

const CLIENT_ID = `cs-${randomUUID().slice(0, 8)}`;
let authz: Authz;

beforeAll(async () => {
  loadStackDefaults();
  authz = createAuthz(authzOptionsFromEnv());
  await ensureSchema(authz);
});

afterAll(async () => {
  await authz.deleteRelationships({
    resourceType: 'api_scope',
    subject: { type: 'client', id: CLIENT_ID },
  });
  authz.close();
});

describe('createScopeResolver against SpiceDB', () => {
  it('resolves the scopes bootstrap-style grants give a client, and nothing for an unknown client', async () => {
    const token = await authz.writeRelationships([
      touch(relationship(apiScope('tenancy:read'), 'grantee', client(CLIENT_ID))),
      touch(relationship(apiScope('tenancy:write'), 'grantee', client(CLIENT_ID))),
    ]);
    expect(token).toBeTruthy();
    // Fully consistent here only because the grants were written a moment ago; the APIs keep the default.
    const resolver = createScopeResolver(authz, { ttlMs: 0, consistency: fullyConsistent });
    await expect(resolver.resolveScopes({ sub: 'alice', client_id: CLIENT_ID })).resolves.toEqual(
      new Set(['tenancy:read', 'tenancy:write']),
    );
    await expect(
      resolver.resolveScopes({ sub: 'alice', client_id: `${CLIENT_ID}-other` }),
    ).resolves.toEqual(new Set());
  });
});
