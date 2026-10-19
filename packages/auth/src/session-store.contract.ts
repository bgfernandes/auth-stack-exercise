/**
 * The `SessionStore` contract, run against both adapters (`stores/memory.test.ts` in the unit project,
 * `stores/redis.integration.test.ts` against the compose Redis). Time is injected, so the idle and absolute
 * limits are exercised without waiting; the Redis TTL backstop is asserted in the Redis file.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import type { NewSession, SessionStore, SessionStoreOptions } from './session';

export interface StoreUnderTest {
  store: SessionStore;
  close: () => Promise<void>;
}

export const CONTRACT_LIMITS = { idleSeconds: 60, absoluteSeconds: 600 };
const BASE = 1_700_000_000_000;

export function describeSessionStoreContract(
  name: string,
  factory: (options: Required<SessionStoreOptions>) => Promise<StoreUnderTest>,
): void {
  describe(`SessionStore contract: ${name}`, () => {
    const clock = { now: BASE };
    let store: SessionStore;
    let close: () => Promise<void>;
    let run = 0;

    const session = (overrides: Partial<NewSession> = {}): NewSession => ({
      sub: `alice-${run}`,
      email: 'alice@example.com',
      sid: `sid-${run}`,
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      idToken: 'idt-1',
      accessTokenExpiresAt: clock.now + 600_000,
      authTime: clock.now - 5_000,
      amr: ['pwd'],
      ...overrides,
    });

    beforeAll(async () => {
      ({ store, close } = await factory({ now: () => clock.now, limits: CONTRACT_LIMITS }));
    });
    afterAll(() => close());
    beforeEach(() => {
      clock.now = BASE;
      run += 1;
    });

    it('creates a session with an opaque ID and the timestamps, and gets it back unchanged', async () => {
      const created = await store.create(session());
      expect(created.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(created).toMatchObject({
        ...session(),
        createdAt: BASE,
        lastSeenAt: BASE,
        // The absolute limit counts from the authentication time, 5 s before the creation here.
        absoluteExpiresAt: BASE - 5_000 + 600_000,
      });
      await expect(store.get(created.id)).resolves.toEqual(created);
      await expect(store.get('unknown')).resolves.toBeUndefined();
    });

    it('keeps optional fields optional', async () => {
      const {
        email: _e,
        sid: _s,
        refreshToken: _r,
        idToken: _i,
        authTime: _a,
        ...minimal
      } = session();
      const created = await store.create(minimal);
      const got = await store.get(created.id);
      expect(got).toEqual(created);
      expect(got).not.toHaveProperty('sid');
      expect(got).not.toHaveProperty('refreshToken');
      // Without an authentication time the absolute limit counts from the creation.
      expect(created.absoluteExpiresAt).toBe(BASE + 600_000);
    });

    it('anchors the absolute limit to an authentication time older than the creation, never later', async () => {
      // An app signed into 100 s after the IdP login shares that login's window.
      const { id } = await store.create(session({ authTime: BASE - 100_000 }));
      const got = await store.get(id);
      expect(got?.absoluteExpiresAt).toBe(BASE - 100_000 + 600_000);
      for (let elapsed = 0; elapsed < 500_000; elapsed += 50_000) {
        await expect(store.touch(id)).resolves.toBe(true);
        clock.now += 50_000;
      }
      // Touched 50 s ago and created 500 s ago, but authenticated 600 s ago.
      await expect(store.get(id)).resolves.toBeUndefined();
      await expect(store.touch(id)).resolves.toBe(false);

      // A token claiming an authentication after the creation (clock skew) does not extend the window.
      clock.now = BASE;
      const later = await store.create(session({ authTime: BASE + 100_000 }));
      expect(later.absoluteExpiresAt).toBe(BASE + 600_000);
    });

    it('expires an untouched session at the idle limit', async () => {
      const { id } = await store.create(session());
      clock.now += 59_000;
      await expect(store.get(id)).resolves.toBeDefined();
      clock.now += 1_000;
      await expect(store.get(id)).resolves.toBeUndefined();
      await expect(store.touch(id)).resolves.toBe(false);
    });

    it('touch slides the idle expiry; the absolute limit still ends the session', async () => {
      const { id } = await store.create(session());
      for (let elapsed = 0; elapsed < 600_000; elapsed += 50_000) {
        await expect(store.touch(id)).resolves.toBe(true);
        clock.now += 50_000;
      }
      // Touched 50 s ago, so not idle, but created 600 s ago.
      await expect(store.get(id)).resolves.toBeUndefined();
      await expect(store.touch(id)).resolves.toBe(false);
    });

    it('update writes the refreshed tokens and counts as activity', async () => {
      const { id } = await store.create(session());
      clock.now += 50_000;
      await expect(
        store.update(id, {
          accessToken: 'at-2',
          refreshToken: 'rt-2',
          accessTokenExpiresAt: clock.now + 600_000,
        }),
      ).resolves.toBe(true);
      clock.now += 50_000;
      const got = await store.get(id);
      expect(got).toMatchObject({
        accessToken: 'at-2',
        refreshToken: 'rt-2',
        idToken: 'idt-1',
        lastSeenAt: BASE + 50_000,
      });
      await expect(store.update('unknown', { accessToken: 'x' })).resolves.toBe(false);
    });

    it('never recreates a deleted session: touch and update after delete are no-ops', async () => {
      const { id } = await store.create(session());
      await store.delete(id);
      await expect(store.touch(id)).resolves.toBe(false);
      await expect(store.update(id, { accessToken: 'at-2' })).resolves.toBe(false);
      await expect(store.get(id)).resolves.toBeUndefined();
      await expect(store.listByUser(session().sub)).resolves.toEqual([]);
    });

    it('deleteByLogoutToken: sid only, sub only, both, a mismatched pair, and an unknown sid with a known sub', async () => {
      const sub = `bob-${run}`;
      const a = await store.create(session({ sub, sid: `sid-a-${run}` }));
      const b = await store.create(session({ sub, sid: `sid-a-${run}` }));
      const c = await store.create(session({ sub, sid: `sid-c-${run}` }));
      const d = await store.create(session({ sub: `dan-${run}`, sid: `sid-d-${run}` }));

      // A mismatched pair: a sid of bob's sessions with dan's sub removes nothing of either user.
      await expect(
        store.deleteByLogoutToken({ sid: `sid-a-${run}`, sub: `dan-${run}` }),
      ).resolves.toBe(0);
      await expect(store.get(a.id)).resolves.toBeDefined();
      await expect(store.get(d.id)).resolves.toBeDefined();

      await expect(store.deleteByLogoutToken({ sid: `sid-a-${run}` })).resolves.toBe(2);
      await expect(store.get(a.id)).resolves.toBeUndefined();
      await expect(store.get(b.id)).resolves.toBeUndefined();
      await expect(store.get(c.id)).resolves.toBeDefined();

      await expect(
        store.deleteByLogoutToken({ sid: `sid-d-${run}`, sub: `dan-${run}` }),
      ).resolves.toBe(1);
      await expect(store.get(d.id)).resolves.toBeUndefined();

      // A sid no live session carries, with a known sub: every session of the user, not nothing.
      await expect(store.deleteByLogoutToken({ sid: `sid-unknown-${run}`, sub })).resolves.toBe(1);
      await expect(store.get(c.id)).resolves.toBeUndefined();
      await expect(store.deleteByLogoutToken({ sid: `sid-unknown-${run}`, sub })).resolves.toBe(0);
      await expect(store.deleteByLogoutToken({ sid: `sid-unknown-${run}` })).resolves.toBe(0);

      const e = await store.create(session({ sub, sid: `sid-e-${run}` }));
      await expect(store.deleteByLogoutToken({ sub })).resolves.toBe(1);
      await expect(store.get(e.id)).resolves.toBeUndefined();
      await expect(store.deleteByLogoutToken({})).resolves.toBe(0);
    });

    it('lists and revokes every live session of a user', async () => {
      const sub = `carol-${run}`;
      const a = await store.create(session({ sub }));
      clock.now += 30_000;
      const { sid: _noSid, ...withoutSid } = session({ sub });
      const b = await store.create(withoutSid);
      clock.now += 40_000; // a is idle now, b is not
      const listed = await store.listByUser(sub);
      expect(listed.map((s) => s.id)).toEqual([b.id]);
      await expect(store.deleteByUser(sub)).resolves.toBe(1);
      await expect(store.get(b.id)).resolves.toBeUndefined();
      await expect(store.get(a.id)).resolves.toBeUndefined();
      await expect(store.listByUser(sub)).resolves.toEqual([]);
    });
  });
}
