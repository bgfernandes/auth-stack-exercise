/**
 * An organization's authentication-context policy (docs/README.md §9.1): floors on the session's quality that
 * the BFFs enforce with RFC 9470 step-up (ticket 24). Stored as JSON on `organizations.policy`; `{}` means no
 * floor, which is what personal organizations keep.
 */
import { z } from 'zod';

export const policySchema = z
  .object({
    /** The session must carry an `amr` of a multi-factor login. */
    require_mfa: z.boolean().optional(),
    /** The login (`auth_time`) must be at most this many seconds old when touching the organization's content. */
    max_auth_age_seconds: z.number().int().positive().optional(),
    /** The login must have gone through this identity provider (a Zitadel IdP ID). */
    require_idp: z.string().min(1).optional(),
  })
  .strict();

export type Policy = z.infer<typeof policySchema>;

/** Parses untrusted input into a policy, or throws a `ZodError` naming the offending field. */
export function parsePolicy(input: unknown): Policy {
  return policySchema.parse(input);
}
