/**
 * The save route's handler (docs/README.md §6.5, §9): a same-origin `POST` of the edit form carrying the session's
 * synchronizer token, as the signed-in user, validated before anything is looked up, enforced by `dashboard-api` at full consistency, answered with a
 * redirect the browser follows or with the status a replayed `curl` reads. Built with its dependencies so the
 * unit tests fake them; `app/documents/[id]/route.ts` binds it to the app.
 */
import { assertSameOrigin, CSRF_FIELD } from '@auth-stack/auth';
import { documentValuesSchema, type DocumentsClient } from '@auth-stack/documents/client';
import { type UserContext } from '@auth-stack/tenancy/client';

import { refusalOf } from './api-refusal';
import { type AppLogger } from './log';

export interface DocumentSaverDeps {
  documents: Pick<DocumentsClient, 'updateDocument'>;
  /** The app's public URL: what the request's `Origin` must match, and the base of the redirects. */
  appUrl: string;
  /** The user behind the request's session cookie, with a live access token; undefined when there is none. */
  userFromRequest: (request: Request) => Promise<UserContext | undefined>;
  /** Whether the posted `csrf_token` is the session's (§9, "CSRF"): the third layer, after the origin check. */
  verifyCsrfToken: (presented: unknown) => Promise<boolean>;
  logger: Pick<AppLogger, 'info' | 'warn'>;
}

export type DocumentSaver = (request: Request, documentId: string) => Promise<Response>;

const STATUS_OF = { unauthenticated: 401, forbidden: 403, not_found: 404 } as const;
const TEXT_OF = {
  unauthenticated: 'Unauthorized',
  forbidden: 'Forbidden',
  not_found: 'Not Found',
} as const;

export function createDocumentSaver(deps: DocumentSaverDeps): DocumentSaver {
  const { documents, appUrl, userFromRequest, verifyCsrfToken, logger } = deps;
  const redirect = (path: string) => Response.redirect(new URL(path, appUrl), 303);

  return async (request, documentId) => {
    try {
      assertSameOrigin(request, appUrl);
    } catch (error) {
      logger.warn('document.save_rejected', {
        reason: error instanceof Error ? error.message : 'origin',
      });
      return new Response('Forbidden', { status: 403 });
    }
    const user = await userFromRequest(request);
    if (!user) return new Response('Unauthorized', { status: 401 });

    // Validation before any lookup: a bad body answers the same for every ID, so it leaks nothing (§9).
    const form = await formOf(request);
    if (!form) return new Response('Bad Request', { status: 400 });
    if (!(await verifyCsrfToken(form.get(CSRF_FIELD)))) {
      logger.warn('document.save_rejected', { reason: 'csrf_token_invalid' });
      return new Response('Forbidden', { status: 403 });
    }
    const values = documentValuesSchema.safeParse({
      value1: form.get('value1'),
      value2: form.get('value2'),
    });
    if (!values.success)
      return redirect(`/documents/${encodeURIComponent(documentId)}/edit?error=values`);

    try {
      await documents.updateDocument(user, documentId, values.data);
    } catch (error) {
      const refusal = refusalOf(error);
      if (!refusal) throw error;
      logger.info('document.save_denied', { sub: user.sub, documentId, code: refusal });
      return new Response(TEXT_OF[refusal], { status: STATUS_OF[refusal] });
    }
    logger.info('document.updated', { sub: user.sub, documentId });
    return redirect(`/dashboard?saved=${encodeURIComponent(documentId)}`);
  };
}

/** The form body, or undefined when the request does not carry one (a crafted request). */
async function formOf(request: Request): Promise<FormData | undefined> {
  try {
    return await request.formData();
  } catch {
    return undefined;
  }
}
