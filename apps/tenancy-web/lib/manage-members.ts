/**
 * The member list's write route (ticket 17): `POST /organizations/:id/members` with one member and the role
 * they get (`admin`, `member`) or `remove`, from the buttons next to each row. The API holds every rule
 * (docs/README.md §6.8): who may, that the user is a current member, that the last administrator stays one.
 */
import { z } from 'zod';

import { type TenancyClient } from '@auth-stack/tenancy/client';

import {
  acceptForm,
  backToOrganization,
  refusal,
  type FormHandler,
  type FormHandlerDeps,
} from './form-handler';

export interface MembershipHandlerDeps extends FormHandlerDeps {
  tenancy: Pick<TenancyClient, 'setMembership'>;
}

/** What the row's form posts: the member and the pressed button. */
export const membershipFormSchema = z.object({
  member_id: z.string().min(1),
  role: z.enum(['admin', 'member', 'remove']),
});

export function createMembershipHandler(deps: MembershipHandlerDeps): FormHandler {
  const { tenancy, appUrl, logger } = deps;
  return async (request, organizationId) => {
    const accepted = await acceptForm(request, deps, 'membership.rejected');
    if (accepted instanceof Response) return accepted;
    const { user, form } = accepted;
    const change = membershipFormSchema.safeParse({
      member_id: form.get('member_id'),
      role: form.get('role'),
    });
    if (!change.success) return new Response('Bad Request', { status: 400 });
    const role = change.data.role === 'remove' ? null : change.data.role;
    try {
      await tenancy.setMembership(user, organizationId, change.data.member_id, role);
    } catch (error) {
      const { response, code } = refusal(error, appUrl, organizationId);
      logger.info('membership.denied', { sub: user.sub, organizationId, code });
      return response;
    }
    logger.info('membership.changed', {
      sub: user.sub,
      organizationId,
      memberId: change.data.member_id,
      role,
    });
    return backToOrganization(appUrl, organizationId, { saved: 'members' });
  };
}
