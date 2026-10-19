/**
 * Just-in-time provisioning (docs/README.md §6.4), run by the login callback on every login (`onLogin` of
 * `@auth-stack/auth/next`): tenancy creates the user mirror and the personal organization on the first call for
 * the `sub` (userinfo asked by `tenancy-api` with the same token), then `dashboard-api` creates the "Personal"
 * project with its "Welcome" document in that organization. Both calls are idempotent and key on the absence of
 * what they create, so a seeded user gets a workspace on first login too, and a repeat is two reads. A failure
 * of either propagates: the binding deletes the session and fails the login. A first login lands on a dashboard
 * hinted with the "Welcome" document it created, so the listing holds the new workspace at once (§7.3: the
 * writer's own write); a repeat lands where every login does.
 */
import { type Session } from '@auth-stack/auth';
import { type DocumentsClient } from '@auth-stack/documents/client';
import { type TenancyClient } from '@auth-stack/tenancy/client';

import { type AppLogger } from './log';

export interface ProvisioningDeps {
  tenancy: Pick<TenancyClient, 'provisionUser'>;
  documents: Pick<DocumentsClient, 'ensurePersonalProject'>;
  logger: Pick<AppLogger, 'info'>;
}

/** What the hook needs of the session: who, and the token the APIs verify. */
export type LoginSession = Pick<Session, 'sub' | 'accessToken'>;

export function createWorkspaceProvisioner(
  deps: ProvisioningDeps,
): (session: LoginSession) => Promise<string | undefined> {
  const { tenancy, documents, logger } = deps;
  return async (session) => {
    const user = { sub: session.sub, accessToken: session.accessToken };
    const { organization, created } = await tenancy.provisionUser(user);
    const workspace = await documents.ensurePersonalProject(user, organization.id);
    // Only a first login is worth a line; a repeat created nothing.
    if (created || workspace.created) {
      logger.info('workspace.provisioned', {
        sub: session.sub,
        organizationId: organization.id,
        organizationCreated: created,
        projectId: workspace.project.id,
        projectCreated: workspace.created,
      });
    }
    return workspace.created
      ? `/dashboard?created=${encodeURIComponent(workspace.document.id)}`
      : undefined;
  };
}
