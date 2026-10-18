/**
 * `@auth-stack/tenancy/testing`: the `TenancyClient` contract, run against the in-process implementation
 * (packages/tenancy's integration test) and the HTTP one over `tenancy-api` (the API's integration test), so
 * the two cannot answer differently. Refusals are asserted by `code`, which both `TenancyError` and
 * `TenancyClientError` carry.
 */
import { describe, expect, it } from '@jest/globals';

import type { Role, TenancyClient, UserContext } from '../client/index';

export interface TenancyClientHarness {
  client: TenancyClient;
  /** A context for a user of this run named `name`, whose claims the implementation resolves to an email and name. */
  user: (name: string) => Promise<UserContext>;
  /**
   * Seeds a shared organization the way bootstrap does (§6.3): the mirror rows with these display names and
   * the roles. Returns its ID; the harness cleans it up.
   */
  sharedOrganization: (
    name: string,
    members: { sub: string; displayName: string; role: Role }[],
  ) => Promise<string>;
  /** Called with every organization the contract creates, for the harness to clean up. */
  track?: (organizationId: string) => void;
}

export function describeTenancyClientContract(
  name: string,
  harness: () => TenancyClientHarness,
): void {
  describe(`TenancyClient contract (${name})`, () => {
    it('provisions the personal organization once and returns it on every later call', async () => {
      const { client, user, track } = harness();
      const owner = await user('owner');
      const first = await client.provisionUser(owner);
      track?.(first.organization.id);
      expect(first.created).toBe(true);
      expect(first.organization).toEqual({
        id: first.organization.id,
        name: 'Personal',
        isPersonal: true,
        policy: {},
      });
      const second = await client.provisionUser(owner);
      expect(second).toEqual({ organization: first.organization, created: false });
    });

    it('shows an organization to a user who may view it and nothing to anyone else', async () => {
      const { client, user, track } = harness();
      const owner = await user('viewer');
      const other = await user('stranger');
      const { organization } = await client.provisionUser(owner);
      track?.(organization.id);
      expect(await client.getOrganization(owner, organization.id)).toEqual(organization);
      expect(await client.listOrganizations(owner)).toContainEqual(organization);
      expect(await client.getOrganization(other, organization.id)).toBeUndefined();
      expect(await client.listOrganizations(other)).not.toContainEqual(organization);
    });

    it('answers undefined for an organization that does not exist', async () => {
      const { client, user } = harness();
      const owner = await user('nobody');
      expect(
        await client.getOrganization(owner, '00000000-0000-4000-8000-000000000000'),
      ).toBeUndefined();
    });

    it('lists the members to every member, admins first, and to nobody else', async () => {
      const { client, user, sharedOrganization } = harness();
      const admin = await user('list-admin');
      const peer = await user('list-peer');
      const stranger = await user('list-stranger');
      const id = await sharedOrganization('Listed', [
        { sub: peer.sub, displayName: 'Zoe Peer', role: 'member' },
        { sub: admin.sub, displayName: 'Ada Admin', role: 'admin' },
      ]);
      const expected = [
        {
          sub: admin.sub,
          email: expect.any(String) as unknown as string,
          displayName: 'Ada Admin',
          role: 'admin',
        },
        {
          sub: peer.sub,
          email: expect.any(String) as unknown as string,
          displayName: 'Zoe Peer',
          role: 'member',
        },
      ];
      expect(await client.listMembers(admin, id)).toEqual(expected);
      expect(await client.listMembers(peer, id)).toEqual(expected);
      expect(await client.listMembers(stranger, id)).toBeUndefined();
      expect(
        await client.listMembers(admin, '00000000-0000-4000-8000-000000000000'),
      ).toBeUndefined();
    });

    it('lets an administrator change or remove a current member, and refuses everything else', async () => {
      const { client, user, sharedOrganization, track } = harness();
      const admin = await user('roles-admin');
      const peer = await user('roles-peer');
      const colleague = await user('roles-colleague');
      const stranger = await user('roles-stranger');
      const id = await sharedOrganization('Managed', [
        { sub: admin.sub, displayName: 'Ada Admin', role: 'admin' },
        { sub: peer.sub, displayName: 'Pat Peer', role: 'member' },
        { sub: colleague.sub, displayName: 'Cal Colleague', role: 'member' },
      ]);
      const roleOf = async (reader: UserContext, sub: string) =>
        (await client.listMembers(reader, id))?.find((member) => member.sub === sub)?.role;

      // A member may not change roles; a stranger learns nothing.
      await expect(client.setMembership(peer, id, colleague.sub, 'admin')).rejects.toMatchObject({
        code: 'forbidden',
      });
      await expect(client.setMembership(stranger, id, peer.sub, 'admin')).rejects.toMatchObject({
        code: 'not_found',
      });

      // Promote and demote: the list reads back the change at once.
      await client.setMembership(admin, id, peer.sub, 'admin');
      expect(await roleOf(admin, peer.sub)).toBe('admin');
      await client.setMembership(admin, id, peer.sub, 'member');
      expect(await roleOf(admin, peer.sub)).toBe('member');

      // Remove: the former member sees nothing, and cannot be given a role back from here (§6.8).
      await client.setMembership(admin, id, colleague.sub, null);
      expect(await roleOf(admin, colleague.sub)).toBeUndefined();
      expect(await client.getOrganization(colleague, id)).toBeUndefined();
      await expect(client.setMembership(admin, id, colleague.sub, 'member')).rejects.toMatchObject({
        code: 'not_a_member',
      });
      await expect(client.setMembership(admin, id, stranger.sub, 'member')).rejects.toMatchObject({
        code: 'not_a_member',
      });

      // The last administrator stays one.
      await expect(client.setMembership(admin, id, admin.sub, 'member')).rejects.toMatchObject({
        code: 'last_admin',
      });
      await expect(client.setMembership(admin, id, admin.sub, null)).rejects.toMatchObject({
        code: 'last_admin',
      });
      expect(await roleOf(admin, admin.sub)).toBe('admin');

      // A personal organization has no membership to manage (§5.1).
      const { organization: personal } = await client.provisionUser(admin);
      track?.(personal.id);
      await expect(
        client.setMembership(admin, personal.id, admin.sub, 'member'),
      ).rejects.toMatchObject({ code: 'personal_organization' });
    });

    it('lets an administrator replace the policy, which the next read shows', async () => {
      const { client, user, sharedOrganization } = harness();
      const admin = await user('policy-admin');
      const peer = await user('policy-peer');
      const id = await sharedOrganization('Governed', [
        { sub: admin.sub, displayName: 'Ada Admin', role: 'admin' },
        { sub: peer.sub, displayName: 'Pat Peer', role: 'member' },
      ]);
      const policy = { require_mfa: true, max_auth_age_seconds: 600 };
      const updated = await client.setPolicy(admin, id, policy);
      expect(updated).toEqual({ id, name: 'Governed', isPersonal: false, policy });
      expect((await client.getOrganization(admin, id))?.policy).toEqual(policy);
      expect((await client.getOrganization(peer, id))?.policy).toEqual(policy);
      await expect(client.setPolicy(peer, id, {})).rejects.toMatchObject({ code: 'forbidden' });
      expect((await client.getOrganization(peer, id))?.policy).toEqual(policy);
    });
  });
}
