/**
 * The policy form's write route (ticket 17): `POST /organizations/:id/policy` replaces the organization's
 * authentication-context floors (docs/README.md §9.1) with what the form carries. An empty field is a floor
 * not set, so the policy is built from the fields that have a value and checked against the schema before the
 * request; the API checks it again.
 */
import { policySchema, type Policy, type TenancyClient } from '@auth-stack/tenancy/client';

import {
  acceptForm,
  backToOrganization,
  refusal,
  type FormHandler,
  type FormHandlerDeps,
} from './form-handler';

export interface PolicyHandlerDeps extends FormHandlerDeps {
  tenancy: Pick<TenancyClient, 'setPolicy'>;
}

/** The form's fields as a policy, or undefined when a value is not one the schema accepts. */
export function policyFromForm(form: FormData): Policy | undefined {
  const policy: Record<string, unknown> = {};
  if (form.get('require_mfa') === 'on') policy.require_mfa = true;
  const maxAge = text(form.get('max_auth_age_seconds'));
  if (maxAge !== undefined) policy.max_auth_age_seconds = Number(maxAge);
  const idp = text(form.get('require_idp'));
  if (idp !== undefined) policy.require_idp = idp;
  const parsed = policySchema.safeParse(policy);
  return parsed.success ? parsed.data : undefined;
}

function text(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function createPolicyHandler(deps: PolicyHandlerDeps): FormHandler {
  const { tenancy, appUrl, logger } = deps;
  return async (request, organizationId) => {
    const accepted = await acceptForm(request, deps, 'policy.rejected');
    if (accepted instanceof Response) return accepted;
    const { user, form } = accepted;
    const policy = policyFromForm(form);
    if (!policy) return backToOrganization(appUrl, organizationId, { error: 'invalid_input' });
    try {
      await tenancy.setPolicy(user, organizationId, policy);
    } catch (error) {
      const { response, code } = refusal(error, appUrl, organizationId);
      logger.info('policy.denied', { sub: user.sub, organizationId, code });
      return response;
    }
    logger.info('policy.updated', { sub: user.sub, organizationId, policy });
    return backToOrganization(appUrl, organizationId, { saved: 'policy' });
  };
}
