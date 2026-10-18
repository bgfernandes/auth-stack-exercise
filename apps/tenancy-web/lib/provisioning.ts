/**
 * Just-in-time provisioning (docs/README.md §6.4), run by the login callback on every login (`onLogin` of
 * `@auth-stack/auth/next`): tenancy creates the user mirror and the personal organization on the first call for
 * the `sub`, idempotently. This app makes the tenancy call only: the personal project is the documents domain's,
 * reached over HTTP from ticket 19 on, and until then `dashboard-web` creates it at the user's first login there.
 */
import { type Session } from '@auth-stack/auth';
import { type TenancyClient } from '@auth-stack/tenancy/client';

import { type AppLogger } from './log';

export interface ProvisioningDeps {
  tenancy: Pick<TenancyClient, 'provisionUser'>;
  logger: Pick<AppLogger, 'info'>;
}

export function createProvisioner(
  deps: ProvisioningDeps,
): (session: Pick<Session, 'sub' | 'accessToken'>) => Promise<void> {
  const { tenancy, logger } = deps;
  return async (session) => {
    const { organization, created } = await tenancy.provisionUser({
      sub: session.sub,
      accessToken: session.accessToken,
    });
    // Only a first login is worth a line; a repeat created nothing.
    if (created)
      logger.info('user.provisioned', { sub: session.sub, organizationId: organization.id });
  };
}
