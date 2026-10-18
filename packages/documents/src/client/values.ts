/**
 * The two editable values of a document (ticket 11): strings of 1 to 200 characters. One rule in one place: the
 * BFF checks it before calling the API, so a bad form never leaves it, and the service enforces it on the write
 * path, so a caller that skipped the check is refused the same way.
 */
import { z } from 'zod';

export const documentValuesSchema = z
  .object({
    value1: z.string().min(1).max(200),
    value2: z.string().min(1).max(200),
  })
  .strict();

export type DocumentValues = z.infer<typeof documentValuesSchema>;

/** Parses untrusted input into document values, or throws a `ZodError` naming the offending field. */
export function parseDocumentValues(input: unknown): DocumentValues {
  return documentValuesSchema.parse(input);
}
