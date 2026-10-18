import { describe, expect, it, jest } from '@jest/globals';

import { type DocumentsClient, type PersonalWorkspaceSummary } from '@auth-stack/documents/client';
import { type TenancyClient } from '@auth-stack/tenancy/client';

import { createProvisioner } from './provisioning';

const organization = { id: 'org-1', name: 'Personal', isPersonal: true, policy: {} };
const workspace = (created: boolean) =>
  ({
    project: { id: 'project-1' },
    document: { id: 'doc-1' },
    created,
  }) as PersonalWorkspaceSummary;

function setup() {
  const calls: string[] = [];
  const provisionUser = jest.fn<TenancyClient['provisionUser']>(() => {
    calls.push('provisionUser');
    return Promise.resolve({ organization, created: true });
  });
  const ensurePersonalProject = jest.fn<DocumentsClient['ensurePersonalProject']>(() => {
    calls.push('ensurePersonalProject');
    return Promise.resolve(workspace(true));
  });
  const events: unknown[] = [];
  const provision = createProvisioner({
    tenancy: { provisionUser },
    documents: { ensurePersonalProject },
    logger: { info: (event, fields) => events.push([event, fields]) },
  });
  return { calls, provisionUser, ensurePersonalProject, events, provision };
}

describe('the login hook', () => {
  it('provisions through tenancy, then the workspace through dashboard-api, with the session token, and logs a first login only', async () => {
    const { calls, provisionUser, ensurePersonalProject, events, provision } = setup();
    await provision({ sub: 'alice', accessToken: 'at-secret' });
    expect(calls).toEqual(['provisionUser', 'ensurePersonalProject']);
    expect(provisionUser).toHaveBeenCalledWith({ sub: 'alice', accessToken: 'at-secret' });
    expect(ensurePersonalProject).toHaveBeenCalledWith(
      { sub: 'alice', accessToken: 'at-secret' },
      'org-1',
    );
    expect(events).toEqual([
      [
        'workspace.provisioned',
        {
          sub: 'alice',
          organizationId: 'org-1',
          organizationCreated: true,
          projectId: 'project-1',
          projectCreated: true,
        },
      ],
    ]);
    provisionUser.mockResolvedValueOnce({ organization, created: false });
    ensurePersonalProject.mockResolvedValueOnce(workspace(false));
    await provision({ sub: 'alice', accessToken: 'at-secret' });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('at-secret');
  });

  it('logs a user whose organization existed but whose project did not (a first login here after the seed)', async () => {
    const { provisionUser, events, provision } = setup();
    provisionUser.mockResolvedValueOnce({ organization, created: false });
    await provision({ sub: 'bob', accessToken: 'x' });
    expect(events).toEqual([
      [
        'workspace.provisioned',
        expect.objectContaining({ organizationCreated: false, projectCreated: true }),
      ],
    ]);
  });

  it('propagates a failure of either call, so the login is refused', async () => {
    const { provisionUser, ensurePersonalProject, provision } = setup();
    provisionUser.mockRejectedValueOnce(new Error('tenancy down'));
    await expect(provision({ sub: 'alice', accessToken: 'x' })).rejects.toThrow('tenancy down');
    expect(ensurePersonalProject).not.toHaveBeenCalled();
    ensurePersonalProject.mockRejectedValueOnce(
      new Error('POST /organizations/org-1/personal-project: 403 insufficient_scope'),
    );
    await expect(provision({ sub: 'alice', accessToken: 'x' })).rejects.toThrow(
      'insufficient_scope',
    );
  });
});
