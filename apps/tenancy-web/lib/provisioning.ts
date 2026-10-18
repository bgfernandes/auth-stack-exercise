/**
 * Just-in-time provisioning (docs/README.md §6.4), run by the login callback on every login (`onLogin` of
 * `@auth-stack/auth/next`): the same two idempotent calls as `dashboard-web`'s, with the user's token. Tenancy
 * creates the user mirror and the personal organization on the first call for the `sub`, then `dashboard-api`
 * creates the "Personal" project with its "Welcome" document in that organization, so a user whose first login
 * is here has a workspace before they ever open the dashboard. A failure of either propagates: the binding
 * deletes the session and fails the login.
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

export function createProvisioner(
  deps: ProvisioningDeps,
): (session: Pick<Session, 'sub' | 'accessToken'>) => Promise<void> {
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
  };
}
