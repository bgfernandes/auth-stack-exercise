import { describe, expect, it, jest } from '@jest/globals';

import { type TenancyClient } from '@auth-stack/tenancy/client';

import { createProvisioner } from './provisioning';

const organization = { id: 'org-1', name: 'Personal', isPersonal: true, policy: {} };

describe('the login hook', () => {
  it('provisions through tenancy with the session token and logs a first login only', async () => {
    const provisionUser = jest.fn<TenancyClient['provisionUser']>();
    const events: unknown[] = [];
    const provision = createProvisioner({
      tenancy: { provisionUser },
      logger: { info: (event, fields) => events.push([event, fields]) },
    });
    provisionUser.mockResolvedValueOnce({ organization, created: true });
    await provision({ sub: 'alice', accessToken: 'at-secret' });
    expect(provisionUser).toHaveBeenCalledWith({ sub: 'alice', accessToken: 'at-secret' });
    expect(events).toEqual([['user.provisioned', { sub: 'alice', organizationId: 'org-1' }]]);
    provisionUser.mockResolvedValueOnce({ organization, created: false });
    await provision({ sub: 'alice', accessToken: 'at-secret' });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('at-secret');
  });

  it('propagates a failure, so the login is refused', async () => {
    const provisionUser = jest.fn<TenancyClient['provisionUser']>(() =>
      Promise.reject(new Error('tenancy down')),
    );
    const provision = createProvisioner({ tenancy: { provisionUser }, logger: { info: () => {} } });
    await expect(provision({ sub: 'alice', accessToken: 'x' })).rejects.toThrow('tenancy down');
  });
});
