/**
 * The direct shares of a document (docs/README.md §6.2, §6.8): the users given `document#editor` or
 * `document#viewer` by the share action, as one set that a share call replaces. Member IDs are Zitadel `sub`s,
 * the subject IDs of the schema; the service checks that each one is a member of the owning organization.
 */
import { z } from 'zod';

import { isObjectId } from '@auth-stack/authz';

const MAX_SHARES = 100;

const memberId = z
  .string()
  .refine(isObjectId, { message: 'not a user id' })
  .describe('the user id (Zitadel sub) of an organization member');

export const documentSharesSchema = z
  .object({
    editors: z.array(memberId).max(MAX_SHARES),
    viewers: z.array(memberId).max(MAX_SHARES),
  })
  .strict()
  .refine(
    (shares) => {
      const all = [...shares.editors, ...shares.viewers];
      return new Set(all).size === all.length;
    },
    { message: 'a user is listed twice', path: ['viewers'] },
  );

export type DocumentShares = z.infer<typeof documentSharesSchema>;

/** Parses untrusted input into a share set, or throws a `ZodError` naming the offending field. */
export function parseDocumentShares(input: unknown): DocumentShares {
  return documentSharesSchema.parse(input);
}
