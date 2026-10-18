/**
 * `@auth-stack/tenancy/testing`: the `TenancyClient` contract, run against the in-process implementation
 * (packages/tenancy's integration test) and the HTTP one over `tenancy-api` (the API's integration test), so
 * the two cannot answer differently.
 */
import { describe, expect, it } from '@jest/globals';

import type { TenancyClient, UserContext } from '../client/index';

export interface TenancyClientHarness {
  client: TenancyClient;
  /** A context for a user of this run named `name`, whose claims the implementation resolves to an email and name. */
  user: (name: string) => Promise<UserContext>;
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
  });
}
