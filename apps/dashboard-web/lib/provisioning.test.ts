/** The composition of the two provisioning calls, with both clients faked: order, arguments, outcome, failures. */
import { describe, expect, it, jest } from '@jest/globals';

import { type DocumentsClient, type PersonalWorkspaceSummary } from '@auth-stack/documents/client';
import { type ProvisionResult, type TenancyClient } from '@auth-stack/tenancy/client';

import { createWorkspaceProvisioner } from './provisioning';

const session = { sub: 'alice', accessToken: 'at-alice' };
const user = { sub: 'alice', accessToken: 'at-alice' };
const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

function provisionResult(created: boolean): ProvisionResult {
  return { organization: { id: ORG, name: 'Personal', isPersonal: true, policy: {} }, created };
}

function workspace(created: boolean): PersonalWorkspaceSummary {
  return { project: { id: PROJECT }, document: { id: 'doc' }, created } as PersonalWorkspaceSummary;
}

function setup(outcomes: { organizationCreated: boolean; projectCreated: boolean }) {
  const calls: string[] = [];
  const provisionUser = jest.fn<TenancyClient['provisionUser']>(() => {
    calls.push('provisionUser');
    return Promise.resolve(provisionResult(outcomes.organizationCreated));
  });
  const ensurePersonalProject = jest.fn<DocumentsClient['ensurePersonalProject']>(() => {
    calls.push('ensurePersonalProject');
    return Promise.resolve(workspace(outcomes.projectCreated));
  });
  const info = jest.fn<(event: string, fields?: Record<string, unknown>) => void>();
  const provision = createWorkspaceProvisioner({
    tenancy: { provisionUser },
    documents: { ensurePersonalProject },
    logger: { info },
  });
  return { calls, provisionUser, ensurePersonalProject, info, provision };
}

describe('createWorkspaceProvisioner', () => {
  it('provisions tenancy first, then the personal project in the organization tenancy answered', async () => {
    const { calls, provisionUser, ensurePersonalProject, info, provision } = setup({
      organizationCreated: true,
      projectCreated: true,
    });
    await provision(session);
    expect(calls).toEqual(['provisionUser', 'ensurePersonalProject']);
    expect(provisionUser).toHaveBeenCalledWith(user);
    expect(ensurePersonalProject).toHaveBeenCalledWith(user, ORG);
    expect(info).toHaveBeenCalledWith('workspace.provisioned', {
      sub: 'alice',
      organizationId: ORG,
      organizationCreated: true,
      projectId: PROJECT,
      projectCreated: true,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('at-alice');
  });

  it('logs a seeded user whose organization existed but whose project did not', async () => {
    const { info, provision } = setup({ organizationCreated: false, projectCreated: true });
    await provision(session);
    expect(info).toHaveBeenCalledWith(
      'workspace.provisioned',
      expect.objectContaining({ organizationCreated: false, projectCreated: true }),
    );
  });

  it('a repeat login makes both calls and logs nothing', async () => {
    const { calls, info, provision } = setup({ organizationCreated: false, projectCreated: false });
    await provision(session);
    expect(calls).toEqual(['provisionUser', 'ensurePersonalProject']);
    expect(info).not.toHaveBeenCalled();
  });

  it('a tenancy failure propagates before the documents domain is asked', async () => {
    const { ensurePersonalProject, provision, provisionUser } = setup({
      organizationCreated: true,
      projectCreated: true,
    });
    provisionUser.mockRejectedValueOnce(new Error('POST /me/provision: 502 userinfo_unavailable'));
    await expect(provision(session)).rejects.toThrow('502 userinfo_unavailable');
    expect(ensurePersonalProject).not.toHaveBeenCalled();
  });

  it('a documents failure propagates', async () => {
    const { ensurePersonalProject, provision } = setup({
      organizationCreated: true,
      projectCreated: true,
    });
    ensurePersonalProject.mockRejectedValueOnce(
      new Error('POST /organizations/x/personal-project: 404 not_found'),
    );
    await expect(provision(session)).rejects.toThrow('404 not_found');
  });
});
